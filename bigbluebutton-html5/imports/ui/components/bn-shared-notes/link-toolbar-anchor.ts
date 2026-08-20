import type * as React from 'react';

type Point = { x: number; y: number };

type LinkToolbarMiddlewareState = {
  x: number;
  y: number;
  elements: {
    reference: Element | {
      contextElement?: Element;
    };
  };
};

const pointInsideRect = (point: Point, rect: DOMRect) => (
  point.x >= rect.left
  && point.x <= rect.right
  && point.y >= rect.top
  && point.y <= rect.bottom
);

const glueLinkToolbarToActiveLine = (pointer: React.RefObject<Point>) => ({
  name: 'glueLinkToolbarToActiveLine',
  fn(state: LinkToolbarMiddlewareState) {
    const { reference } = state.elements;
    const link = reference instanceof Element ? reference : reference.contextElement;
    if (!link) return {};

    const rects = Array.from(link.getClientRects());
    if (rects.length === 0) return {};

    const selection = document.getSelection();
    const caretRange = selection?.rangeCount
      ? selection.getRangeAt(0)
      : undefined;
    const caretRect = caretRange && link.contains(caretRange.commonAncestorContainer)
      ? caretRange.getBoundingClientRect()
      : undefined;
    const activePoint = caretRect
      ? { x: caretRect.x, y: caretRect.y + caretRect.height / 2 }
      : pointer.current;
    const target = (activePoint && rects.find((rect) => pointInsideRect(activePoint, rect))) ?? rects[0];
    const union = link.getBoundingClientRect();

    // BlockNote anchors wrapped links to their union box. Rebase its virtual
    // reference onto the active line because inline() cannot access its client rects.
    return {
      x: state.x + target.left - union.left,
      y: state.y + target.top - union.top - 10,
    };
  },
});

export default glueLinkToolbarToActiveLine;
