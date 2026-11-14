import { describe, expect, it } from 'vitest';
import type { Target } from '../../mcp/cursor';
import { HEADER_W, RULER_H } from '../timeline/layout';
import {
  anchorPoint,
  boxCenter,
  canvasToScreen,
  ARROW_H,
  ARROW_W,
  clampPoint,
  esc,
  intersect,
  locateTarget,
  timeToX,
  topMiddle,
  visibleSpot,
  type Box,
  type Env,
} from './locate';

const box = (left: number, top: number, width: number, height: number): Box => ({ left, top, width, height });

describe('clampPoint', () => {
  it('keeps a point inside a box and moves an outside one to the edge', () => {
    const b = box(10, 20, 100, 50);
    expect(clampPoint({ x: 50, y: 30 }, b)).toEqual({ x: 50, y: 30 });
    expect(clampPoint({ x: -5, y: 30 }, b)).toEqual({ x: 10, y: 30 });
    expect(clampPoint({ x: 500, y: 30 }, b)).toEqual({ x: 110, y: 30 });
    expect(clampPoint({ x: 50, y: 0 }, b)).toEqual({ x: 50, y: 20 });
    expect(clampPoint({ x: 50, y: 999 }, b)).toEqual({ x: 50, y: 70 });
  });

  it('a box with no room is a point', () => {
    expect(clampPoint({ x: 50, y: 50 }, box(10, 20, -5, -5))).toEqual({ x: 10, y: 20 });
  });
});

describe('intersect and visibleSpot', () => {
  it('the shared part of two boxes', () => {
    expect(intersect(box(0, 0, 100, 100), box(50, 50, 100, 100))).toEqual(box(50, 50, 50, 50));
    expect(intersect(box(0, 0, 10, 10), box(20, 20, 10, 10))).toBeNull();
    expect(intersect(box(0, 0, 10, 10), box(10, 0, 10, 10))).toEqual(box(10, 0, 0, 10));
  });

  it('points at the middle of the part that can be seen', () => {
    // a clip from x 0 to 400, only 100..300 is in sight
    expect(visibleSpot(box(0, 10, 400, 40), box(100, 0, 200, 100))).toEqual({ x: 200, y: 30 });
    // fully in sight: its own middle
    expect(visibleSpot(box(120, 10, 40, 40), box(100, 0, 200, 100))).toEqual({ x: 140, y: 30 });
  });

  it('a box out of sight goes to the nearest edge of the bounds', () => {
    const bounds = box(100, 50, 200, 100);
    expect(visibleSpot(box(-500, 60, 100, 40), bounds)).toEqual({ x: 100, y: 80 });
    expect(visibleSpot(box(900, 60, 100, 40), bounds)).toEqual({ x: 300, y: 80 });
    expect(visibleSpot(box(150, 900, 100, 40), bounds)).toEqual({ x: 200, y: 150 });
    expect(visibleSpot(box(150, -900, 100, 40), bounds)).toEqual({ x: 200, y: 50 });
  });
});

describe('timeToX', () => {
  it('time times zoom, minus the scroll, from where the lanes start', () => {
    expect(timeToX(0, 100, 0, 250)).toBe(250);
    expect(timeToX(2, 100, 0, 250)).toBe(450);
    expect(timeToX(2, 100, 120, 250)).toBe(330);
    expect(timeToX(0.5, 40, 1000, 0)).toBe(-980);
  });
});

describe('canvasToScreen', () => {
  const frame = box(100, 50, 640, 360); // a 1920x1080 project at a third of its size
  it('0 / 0 is the middle of the frame', () => {
    expect(canvasToScreen(0, 0, frame, 1920, 1080)).toEqual({ x: 420, y: 230 });
  });
  it('project pixels are scaled to the frame', () => {
    expect(canvasToScreen(960, 540, frame, 1920, 1080)).toEqual({ x: 740, y: 410 });
    expect(canvasToScreen(-960, -540, frame, 1920, 1080)).toEqual({ x: 100, y: 50 });
    expect(canvasToScreen(300, -150, frame, 1920, 1080)).toEqual({ x: 520, y: 180 });
  });
  it('a point outside the canvas lands outside the frame (the caller clamps it)', () => {
    expect(canvasToScreen(2000, 0, frame, 1920, 1080).x).toBeGreaterThan(740);
  });
  it('a project with no size does not divide by zero', () => {
    const p = canvasToScreen(5, 5, frame, 0, 0);
    expect(Number.isFinite(p.x) && Number.isFinite(p.y)).toBe(true);
  });
});

describe('small helpers', () => {
  it('topMiddle, boxCenter, anchorPoint', () => {
    expect(topMiddle(1000)).toEqual({ x: 500, y: 0 });
    expect(boxCenter(box(10, 20, 100, 40))).toEqual({ x: 60, y: 40 });
    expect(anchorPoint(box(10, 20, 100, 40), 0.5, 0.25)).toEqual({ x: 60, y: 30 });
  });
});

// ---------- the dom side, with a fake document ----------

function envOf(boxes: Record<string, Box>, over: Partial<Env> = {}): Env {
  return {
    dom: { query: (selector) => (boxes[selector] ? { getBoundingClientRect: () => boxes[selector]! } : null) },
    win: { width: 1600, height: 900 },
    zoom: 100,
    scrollLeft: 0,
    project: { width: 1920, height: 1080 },
    clip: () => undefined,
    ...over,
  };
}

// a timeline at the bottom of the window: scroller x 0..1000, y 500..800
const SCROLLER = box(0, 500, 1000, 300);
const base = {
  '.timeline-scroller': SCROLLER,
  '.timeline-ruler': box(HEADER_W, 500, 3000, RULER_H),
};

describe('locateTarget: the timeline', () => {
  it('a clip with an element: the middle of what can be seen', () => {
    const env = envOf({ ...base, '[data-clip-id="c1"]': box(300, 540, 200, 56) });
    expect(locateTarget({ kind: 'clip', id: 'c1' }, env)).toEqual({ x: 400, y: 568 });
  });

  it('a clip half under the track headers is pointed at on its visible part', () => {
    const env = envOf({ ...base, '[data-clip-id="c1"]': box(50, 540, 300, 56) });
    // visible from x 150 (HEADER_W) to 350
    expect(locateTarget({ kind: 'clip', id: 'c1' }, env)).toEqual({ x: 250, y: 568 });
  });

  it('a clip that is not mounted is worked out from the store: start * zoom - scroll', () => {
    const env = envOf(
      { ...base, '.timeline-lane[data-track-id="t1"]': box(HEADER_W, 560, 3000, 56) },
      { scrollLeft: 100, clip: (id) => (id === 'far' ? { start: 3, duration: 2, trackId: 't1' } : undefined) },
    );
    // x from 0 + 150 + 300 - 100 = 350 to 550, y middle of the lane 588
    expect(locateTarget({ kind: 'clip', id: 'far' }, env)).toEqual({ x: 450, y: 588 });
  });

  it('a clip scrolled out of sight is clamped to the edge of the lanes, the scroll is not touched', () => {
    const lane = { '.timeline-lane[data-track-id="t1"]': box(HEADER_W, 560, 3000, 56) };
    const env = envOf({ ...base, ...lane }, { scrollLeft: 0, clip: () => ({ start: 50, duration: 2, trackId: 't1' }) });
    expect(locateTarget({ kind: 'clip', id: 'x' }, env)).toEqual({ x: 1000, y: 588 });
    const left = envOf({ ...base, ...lane }, { scrollLeft: 5000, clip: () => ({ start: 1, duration: 1, trackId: 't1' }) });
    expect(locateTarget({ kind: 'clip', id: 'x' }, left)).toEqual({ x: HEADER_W, y: 588 });
    expect(left.scrollLeft).toBe(5000);
  });

  it('a lane scrolled out of sight vertically is clamped to the bottom / top of the timeline', () => {
    const env = envOf({ ...base, '.timeline-lane[data-track-id="t1"]': box(HEADER_W, 1200, 3000, 56) }, { clip: () => ({ start: 1, duration: 1, trackId: 't1' }) });
    expect(locateTarget({ kind: 'clip', id: 'x' }, env)?.y).toBe(800);
  });

  it('a clip that is nowhere (editor closed, clip unknown) can not be found', () => {
    expect(locateTarget({ kind: 'clip', id: 'x' }, envOf({}))).toBeNull();
    expect(locateTarget({ kind: 'clip', id: 'x' }, envOf(base))).toBeNull();
    expect(locateTarget({ kind: 'clips', ids: [] }, envOf(base))).toBeNull();
  });

  it('clips: the first one', () => {
    const env = envOf({ ...base, '[data-clip-id="a"]': box(300, 540, 100, 56), '[data-clip-id="b"]': box(600, 540, 100, 56) });
    expect(locateTarget({ kind: 'clips', ids: ['a', 'b'] }, env)).toEqual({ x: 350, y: 568 });
  });

  it('a track is its header', () => {
    const env = envOf({ ...base, '.timeline-head[data-track-id="t1"]': box(0, 560, HEADER_W, 56) });
    expect(locateTarget({ kind: 'track', id: 't1' }, env)).toEqual({ x: HEADER_W / 2, y: 588 });
    // a header under the bottom edge is clamped to it
    const low = envOf({ ...base, '.timeline-head[data-track-id="t1"]': box(0, 2000, HEADER_W, 56) });
    expect(locateTarget({ kind: 'track', id: 't1' }, low)?.y).toBe(800);
    expect(locateTarget({ kind: 'track', id: 'zz' }, env)).toBeNull();
  });

  it('a time is on the ruler at time * zoom - scrollLeft', () => {
    const env = envOf(base, { scrollLeft: 100 });
    expect(locateTarget({ kind: 'time', time: 3 }, env)).toEqual({ x: HEADER_W + 300 - 100, y: 513 });
    // before the first visible time and after the last one: the edges
    expect(locateTarget({ kind: 'time', time: 0 }, envOf(base, { scrollLeft: 100 }))?.x).toBe(HEADER_W);
    expect(locateTarget({ kind: 'time', time: 60 }, env)?.x).toBe(1000);
    expect(locateTarget({ kind: 'time', time: 1 }, envOf({}))).toBeNull();
  });
});

describe('locateTarget: the rest of the window', () => {
  it('the canvas: the frame is the project, 0 / 0 is its middle', () => {
    const frame = box(100, 50, 640, 360);
    const env = envOf({ '.preview-frame': frame, '.preview-stage': box(0, 0, 1000, 600) });
    expect(locateTarget({ kind: 'canvas', x: 0, y: 0 }, env)).toEqual({ x: 420, y: 230 });
    expect(locateTarget({ kind: 'canvas', x: 960, y: 540 }, env)).toEqual({ x: 740, y: 410 });
    // off the stage: the edge of the panel
    expect(locateTarget({ kind: 'canvas', x: 99999, y: 0 }, env)).toEqual({ x: 1000, y: 230 });
    expect(locateTarget({ kind: 'canvas', x: 0, y: 0 }, envOf({ '.preview-frame': frame }, { project: null }))).toBeNull();
    expect(locateTarget({ kind: 'canvas', x: 0, y: 0 }, envOf({}))).toBeNull();
  });

  it('the preview, the inspector and the buttons', () => {
    const env = envOf({
      '.preview-stage': box(200, 40, 600, 400),
      '.props-panel': box(1200, 40, 300, 800),
      'button[aria-label="undo"]': box(900, 5, 28, 28),
      'button[aria-label="redo"]': box(930, 5, 28, 28),
      '.shell-header .btn-primary': box(1500, 5, 80, 28),
    });
    expect(locateTarget({ kind: 'preview' }, env)).toEqual({ x: 500, y: 240 });
    expect(locateTarget({ kind: 'inspector' }, env)).toEqual({ x: 1350, y: 240 });
    expect(locateTarget({ kind: 'button', which: 'undo' }, env)).toEqual({ x: 914, y: 19 });
    expect(locateTarget({ kind: 'button', which: 'redo' }, env)).toEqual({ x: 944, y: 19 });
    expect(locateTarget({ kind: 'button', which: 'export' }, env)).toEqual({ x: 1540, y: 19 });
    expect(locateTarget({ kind: 'button', which: 'undo' }, envOf({}))).toBeNull();
  });

  it('media: a card, else the panel', () => {
    const env = envOf({ '.media-panel': box(0, 40, 300, 400), '[data-asset-id="a1"]': box(10, 100, 120, 80) });
    expect(locateTarget({ kind: 'media', id: 'a1' }, env)).toEqual({ x: 70, y: 140 });
    expect(locateTarget({ kind: 'media', id: 'gone' }, env)).toEqual({ x: 150, y: 160 });
    expect(locateTarget({ kind: 'media' }, env)).toEqual({ x: 150, y: 160 });
    expect(locateTarget({ kind: 'media' }, envOf({}))).toBeNull();
  });

  it('the projects screen: a card, the new project button, the screen, or the way back from the editor', () => {
    const env = envOf({
      '.projects': box(0, 0, 1600, 900),
      '[data-project-id="p1"]': box(100, 200, 200, 150),
      'button[title="new project (n)"]': box(1400, 10, 120, 28),
    });
    expect(locateTarget({ kind: 'projects', id: 'p1' }, env)).toEqual({ x: 200, y: 275 });
    expect(locateTarget({ kind: 'projects', create: true }, env)).toEqual({ x: 1460, y: 24 });
    expect(locateTarget({ kind: 'projects' }, env)).toEqual({ x: 800, y: 270 });
    // an unknown card falls back to the screen
    expect(locateTarget({ kind: 'projects', id: 'zz' }, env)).toEqual({ x: 800, y: 270 });
    const editor = envOf({ 'button[aria-label="back to projects"]': box(10, 5, 28, 28) });
    expect(locateTarget({ kind: 'projects' }, editor)).toEqual({ x: 24, y: 19 });
    expect(locateTarget({ kind: 'projects' }, envOf({}))).toBeNull();
  });

  it('nowhere can not be found: the cursor stays', () => {
    expect(locateTarget({ kind: 'nowhere' }, envOf(base))).toBeNull();
  });

  it('an element with no size (display none) counts as not there', () => {
    expect(locateTarget({ kind: 'preview' }, envOf({ '.preview-stage': box(0, 0, 0, 0) }))).toBeNull();
  });

  it('every spot stays inside the window', () => {
    const env = envOf({ '.preview-stage': box(1500, 800, 400, 400) });
    // the tip keeps the width and height of the arrow away from the right and bottom edge, so the arrow is seen
    expect(locateTarget({ kind: 'preview' }, env)).toEqual({ x: 1600 - ARROW_W, y: 900 - ARROW_H });
  });

  it('a clip scrolled out past the right end of the timeline keeps its arrow in the window', () => {
    const env = envOf({ ...base, '.timeline-scroller': box(0, 500, 1600, 300) }, { clip: () => ({ start: 500, duration: 2, trackId: 't' }) });
    const p = locateTarget({ kind: 'clip', id: 'far' }, { ...env, dom: { query: (q) => (q === '.timeline-lane[data-track-id="t"]' ? { getBoundingClientRect: () => box(HEADER_W, 560, 40000, 60) } : env.dom.query(q)) } });
    expect(p).not.toBeNull();
    expect(p!.x).toBeLessThanOrEqual(1600 - ARROW_W);
  });

  it('ids with quotes do not break the selector', () => {
    const asked: string[] = [];
    const env: Env = { ...envOf({}), dom: { query: (s) => (asked.push(s), null) } };
    locateTarget({ kind: 'clip', id: 'a"]x\\' }, env);
    expect(asked[1]).toBe('[data-clip-id="a\\"]x\\\\"]');
  });

  it('esc writes control characters as css hex escapes', () => {
    expect(esc('a\nb')).toBe('a\\a b');
    expect(esc('x\r\f\u0000y\u007f')).toBe('x\\d \\c \\0 y\\7f ');
    expect(esc('plain-id_1')).toBe('plain-id_1');
  });

  it('a newline in an id does not throw and finds nothing', () => {
    // a document throws a syntax error for a raw newline inside a quoted attribute value
    const strict: Env = {
      ...envOf({}),
      dom: {
        query: (q) => {
          if (/[\u0000-\u001f]/.test(q)) throw new SyntaxError('bad selector');
          return null;
        },
      },
    };
    const targets: Target[] = [
      { kind: 'clip', id: 'a\nb' },
      { kind: 'clips', ids: ['a\rb'] },
      { kind: 'track', id: 'a\fb' },
      { kind: 'media', id: 'x\ny' },
      { kind: 'projects', id: 'p\nq', create: false },
    ];
    for (const t of targets) {
      expect(() => locateTarget(t, strict)).not.toThrow();
      expect(locateTarget(t, strict)).toBeNull();
    }
  });

  it('a lookup that throws anywhere answers null', () => {
    const env: Env = { ...envOf({}), clip: () => { throw new Error('boom'); }, dom: { query: () => { throw new Error('boom'); } } };
    expect(locateTarget({ kind: 'preview' }, env)).toBeNull();
    expect(locateTarget({ kind: 'clip', id: 'c' }, env)).toBeNull();
  });
});
