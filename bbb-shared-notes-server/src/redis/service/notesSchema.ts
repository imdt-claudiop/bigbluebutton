import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { BlockNoteSchema, createBlockSpec, defaultBlockSpecs } from '@blocknote/core';

/**
 * Shared Notes schema, server side.
 *
 * This MUST mirror the editor schema the html5 client builds in
 * `bigbluebutton-html5/.../bn-shared-notes/component.tsx`: the default BlockNote
 * blocks minus the media blocks the client strips (audio/image/file/video), plus
 * the custom `latex` and `chart` blocks. The Shared Notes pad is one collaborative
 * Yjs document shared by client and server, so any divergence in the block set
 * would desync it - in particular the `chart` block's type/propSchema/content are
 * kept byte-for-byte identical to `chart-block/ChartBlock.tsx`.
 *
 * A NodeView is only ever built when an editor view is mounted in a browser, which
 * never happens in this headless server editor, so the blocks' `render` is never
 * invoked here. It only has to exist so the block participates in the prosemirror
 * schema used for the Yjs (de)serialization - hence the throw-if-called stub.
 */

const headlessRender = (): never => {
  throw new Error('Shared Notes server block render must never run server-side');
};

// Kept byte-for-byte identical to the html5 chart block spec.
const chartBlock = createBlockSpec(
  {
    type: 'chart',
    propSchema: {
      spec: {
        default: '',
      },
    },
    content: 'none',
  },
  { render: headlessRender },
);

// Mirrors the html5 latex block spec so latex blocks already in a pad survive the
// read/append round-trip unchanged.
const latexBlock = createBlockSpec(
  {
    type: 'latex',
    propSchema: {
      formula: {
        default: '',
      },
      displayMode: {
        default: false,
      },
    },
    content: 'none',
  },
  { render: headlessRender },
);

function buildSchema() {
  const {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    audio, image, file, video, ...remainingBlockSpecs
  } = defaultBlockSpecs;

  return BlockNoteSchema.create({
    blockSpecs: {
      ...remainingBlockSpecs,
      latex: latexBlock(),
      chart: chartBlock(),
    },
  });
}

function createNotesEditor() {
  return ServerBlockNoteEditor.create({ schema: buildSchema() });
}

let cachedEditor: ReturnType<typeof createNotesEditor> | null = null;

/**
 * Lazily-built, reused server editor carrying the Shared Notes schema. The editor
 * is stateless across conversions (each call operates on the fragment passed in),
 * so a single instance is safe to share.
 */
export function getNotesEditor() {
  if (!cachedEditor) {
    cachedEditor = createNotesEditor();
  }
  return cachedEditor;
}
