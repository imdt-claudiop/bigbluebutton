import { expect, Response } from '@playwright/test';

import { ELEMENT_WAIT_LONGER_TIME, ELEMENT_WAIT_TIME } from '../../core/constants';
import { elements as e } from '../../core/elements';
import { MultiUsers } from '../../user/multiusers';

// BlockNote-internal selectors (the editor library does not expose data-test
// attributes for these).
const blockNote = {
  editor: '.bn-editor',
  slashMenu: '.bn-suggestion-menu',
  table: '.bn-editor [data-content-type="table"] table',
  tableWrapper: '.bn-editor .tableWrapper',
  // Floating add-row table handle (BlockNote internal): it spans the full table
  // width, so on a table wider than the panel its right edge overflows.
  addRowHandle: '.bn-extend-button-add-remove-rows',
  // The left block side menu (drag handle + "add block" button). It lives in
  // the left gutter and must stay visible/accessible after the overflow fix.
  sideMenu: '.bn-side-menu',
};

export class BlockNoteSharedNotes extends MultiUsers {
  // Regression for https://github.com/bigbluebutton/bigbluebutton/issues/25122:
  // exporting an empty BlockNote shared note must return a file, not an error
  // page ("Export failed: Document is empty...").
  async exportEmptyNotesAsPDF() {
    const { sharedNotesEnabled } = this.modPage.settings || {};

    if (!sharedNotesEnabled) {
      await this.modPage.hasElement(e.chatButton, 'should display the public chat button');
      await this.modPage.wasRemoved(e.sharedNotes, 'should not display the shared notes button');
      return;
    }

    const { page } = this.modPage;

    // Open the (empty) BlockNote shared notes panel. Nothing is typed, so the
    // document stays empty.
    await this.modPage.waitAndClick(e.sharedNotes, ELEMENT_WAIT_LONGER_TIME);
    await this.modPage.hasElement(
      e.sharedNotesBackground,
      'should display the shared notes panel',
      ELEMENT_WAIT_LONGER_TIME,
    );

    // Open the notes options menu and export as PDF. "Export as PDF" is a
    // window.open navigation that returns the file; capture its response.
    // Promise.all keeps a single, handled rejection path and lets
    // waitForEvent own the timeout / listener cleanup.
    await this.modPage.waitAndClick(e.notesOptions, ELEMENT_WAIT_TIME);
    const [pdfResponse] = await Promise.all([
      page.context().waitForEvent('response', {
        predicate: (response: Response) => response.url().includes('/export/pdf'),
        timeout: ELEMENT_WAIT_LONGER_TIME,
      }),
      this.modPage.waitAndClick(e.exportNotesAsPDF, ELEMENT_WAIT_TIME),
    ]);

    expect(pdfResponse.status(), 'empty shared notes PDF export should return 200, not an error').toBe(200);
    expect(
      pdfResponse.headers()['content-type'] || '',
      'empty shared notes PDF export should return a PDF document',
    ).toContain('application/pdf');

    // Issue #25122 is general ("empty page should not be an error"), so every
    // export format must treat an empty document as a valid empty file. Reuse
    // the authenticated export URL and assert via API requests, which are
    // browser-independent (no download-navigation semantics).
    const exportUrl = pdfResponse.url();
    const formats: Array<{ format: string; contentType: string; body?: (text: string) => void }> = [
      { format: 'html', contentType: 'text/html' },
      { format: 'txt', contentType: 'text/plain' },
      { format: 'md', contentType: 'text/plain' },
      {
        format: 'json',
        contentType: 'application/json',
        body: (text) => expect(text.trim(), 'empty JSON export should be []').toBe('[]'),
      },
      { format: 'yjs', contentType: 'text/plain' },
    ];

    for (const { format, contentType, body } of formats) {
      // eslint-disable-next-line no-await-in-loop
      const response = await page.request.get(exportUrl.replace('/export/pdf', `/export/${format}`));
      expect(response.status(), `empty shared notes ${format} export should return 200`).toBe(200);
      expect(
        response.headers()['content-type'] || '',
        `empty shared notes ${format} export should return ${contentType}`,
      ).toContain(contentType);
      // eslint-disable-next-line no-await-in-loop
      if (body) body(await response.text());
    }
  }

  // A table wider than the narrow shared-notes panel must stay usable: the
  // table itself scrolls horizontally (so every column is reachable) and the
  // floating "add row/column" handles stay inside the editor instead of
  // spilling out of the panel, while the left "add block" side menu remains
  // visible. Without the containTableControlsOverflow fix the add-row handle is
  // sized to the full table width and its right edge runs well past the editor.
  async tableControlsStayWithinPanel() {
    const { sharedNotesEnabled } = this.modPage.settings || {};

    if (!sharedNotesEnabled) {
      await this.modPage.hasElement(e.chatButton, 'should display the public chat button');
      await this.modPage.wasRemoved(e.sharedNotes, 'should not display the shared notes button');
      return;
    }

    const { page } = this.modPage;

    await this.modPage.waitAndClick(e.sharedNotes, ELEMENT_WAIT_LONGER_TIME);
    await this.modPage.hasElement(
      e.sharedNotesBackground,
      'should display the shared notes panel',
      ELEMENT_WAIT_LONGER_TIME,
    );
    await this.modPage.hasElement(blockNote.editor, 'should display the BlockNote editor', ELEMENT_WAIT_LONGER_TIME);

    // Insert a table via the slash menu (/table -> "Table").
    await this.modPage.waitAndClick(blockNote.editor);
    await page.keyboard.type('/table');
    await this.modPage.hasElement(blockNote.slashMenu, 'should display the slash command menu');
    await page.keyboard.press('Enter');
    await this.modPage.hasElement(blockNote.table, 'should insert a table', ELEMENT_WAIT_LONGER_TIME);

    // The default BlockNote table is already wider than this narrow panel, so
    // it overflows without any extra columns and exercises the fix directly.
    const table = page.locator(blockNote.table);

    // The table must be wider than its scroll container, i.e. it overflows the
    // panel and so genuinely exercises the fix (and its columns are reachable
    // only via horizontal scroll).
    const wrapperScroll = await page.locator(blockNote.tableWrapper).evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(
      wrapperScroll.scrollWidth,
      'the table should be wider than the panel (its columns reachable via horizontal scroll)',
    ).toBeGreaterThan(wrapperScroll.clientWidth);

    // Hovering the table shows the left side menu ("add block"). BlockNote's
    // floating handles fade in, so they are briefly not "visible" to Playwright
    // even though they have real layout; wait for the element to attach and
    // assert it has a real box inside the panel (the fix must not clip the left
    // gutter). The panel's left edge is the lower bound.
    await table.hover();
    await page.locator(blockNote.sideMenu).waitFor({ state: 'attached', timeout: ELEMENT_WAIT_TIME });
    const panel = await page.locator(e.sharedNotesBackground).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right };
    });
    const sideMenuBox = await page.locator(blockNote.sideMenu).evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, width: r.width };
    });
    expect(sideMenuBox.width, 'the add-block side menu should be rendered (non-zero width)').toBeGreaterThan(0);
    expect(
      sideMenuBox.left,
      'the add-block side menu should not be clipped off the panel left edge',
    ).toBeGreaterThanOrEqual(panel.left);
    expect(sideMenuBox.right, 'the add-block side menu should stay inside the panel').toBeLessThanOrEqual(panel.right);

    // Reveal the add-row handle by hovering near the table's bottom edge, then
    // assert it does not overflow the editor's right edge.
    const tableBox = await table.boundingBox();
    if (!tableBox) throw new Error('could not measure the table');
    await page.mouse.move(tableBox.x + Math.min(tableBox.width / 2, 150), tableBox.y + tableBox.height - 3);
    await page.locator(blockNote.addRowHandle).waitFor({ state: 'attached', timeout: ELEMENT_WAIT_TIME });

    const geometry = await page.evaluate((sel) => {
      const rect = (s: string) => {
        const el = document.querySelector(s);
        return el ? el.getBoundingClientRect().right : null;
      };
      return { addRowRight: rect(sel.addRowHandle), editorRight: rect(sel.editor) };
    }, blockNote);

    expect(geometry.addRowRight, 'add-row handle should be present').not.toBeNull();
    expect(geometry.editorRight, 'editor should be present').not.toBeNull();
    expect(
      geometry.addRowRight!,
      'the add-row table handle should not overflow the editor (it must stay inside the panel)',
    ).toBeLessThanOrEqual(geometry.editorRight!);
  }
}
