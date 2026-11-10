import { describe, expect, it } from 'vitest';
import { createTextClip } from '../../lib/factory';
import { layoutGlyphsFrom, letterClusters, modeBlocker, splitBlocker, splitNotes, splitPlan } from './textSplit';

/** a straight layout: every code point 10 wide, lines 20 apart */
function glyphsOf(lines: string[], curve = 0) {
  const edges = lines.map((l) => [0, ...Array.from(l).map((_, i) => (i + 1) * 10)]);
  const widest = Math.max(...edges.map((e) => e[e.length - 1]!));
  const pad = 5;
  const box = { lines, width: widest + pad * 2, height: lines.length * 20 + pad * 2, pad, lineHeight: 20, spacing: 0, curve, curveRef: widest, curveCx: 0, curveCy: 0 };
  return { box, glyphs: layoutGlyphsFrom(box, 'center', edges) };
}

const texts = (lines: string[]) => {
  const { box, glyphs } = glyphsOf(lines);
  return splitPlan(box, glyphs, 'letters').pieces.map((p) => p.text);
};

describe('letters keep what belongs together', () => {
  it('an accent written as its own mark stays on its letter', () => {
    expect(texts(['café ok'])).toEqual(['c', 'a', 'f', 'é', 'o', 'k']);
  });

  it('joined emoji, skin tones, variation selectors and flags are one piece each', () => {
    const family = '\u{1f468}‍\u{1f469}‍\u{1f467}';
    const wave = '\u{1f44b}\u{1f3fd}';
    const heart = '❤️';
    const flags = '\u{1f1e9}\u{1f1ea}\u{1f1eb}\u{1f1f7}';
    expect(texts([family + 'a'])).toEqual([family, 'a']);
    expect(texts([wave + heart])).toEqual([wave, heart]);
    expect(texts([flags])).toEqual(['\u{1f1e9}\u{1f1ea}', '\u{1f1eb}\u{1f1f7}']);
  });

  it('a cluster sits in the middle of all its glyphs', () => {
    const { box, glyphs } = glyphsOf(['aé']);
    const plan = splitPlan(box, glyphs, 'letters');
    // 3 code points, 30 wide, centered: a at -10, the cluster spans 0 .. 20 before centering => -5 .. 15
    expect(plan.pieces[0]!.cx).toBeCloseTo(-10);
    expect(plan.pieces[1]!.cx).toBeCloseTo(5);
  });

  it('a mark at the start of a line does not join the line before', () => {
    const { glyphs } = glyphsOf(['a', '́b']);
    expect(letterClusters(glyphs).map((c) => c.map((g) => g.ch).join(''))).toEqual(['a', '́', 'b']);
  });

  it('plain text is unchanged', () => {
    expect(texts(['ab cd', 'ef'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });
});

describe('splitBlocker, what a split cannot carry', () => {
  const base = createTextClip('t', 0, { text: 'hello there' });

  it('a plain text can be split', () => {
    expect(splitBlocker(base)).toBeNull();
  });

  it('refuses a 3d text that looks at something, not a flat one', () => {
    expect(splitBlocker({ ...base, threeD: true, lookAt: 'camera' })).toMatch(/look at/);
    expect(splitBlocker({ ...base, threeD: true, lookAt: 'none' })).toBeNull();
    expect(splitBlocker({ ...base, lookAt: 'camera' })).toBeNull();
  });

  it('refuses a mask and a real crop', () => {
    expect(splitBlocker({ ...base, mask: { shape: 'ellipse', x: 0, y: 0, width: 1, height: 1, rotation: 0, feather: 0, invert: false } })).toMatch(/mask/);
    expect(splitBlocker({ ...base, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } })).toMatch(/crop/);
    expect(splitBlocker({ ...base, crop: { left: 0, top: 0, right: 0, bottom: 0 } })).toBeNull();
  });

  it('refuses an animation that runs letter by letter, allows one on the whole block', () => {
    expect(splitBlocker({ ...base, animIn: { id: 'typewriter', duration: 0.6 } })).toMatch(/letter by letter/);
    expect(splitBlocker({ ...base, animOut: { id: 'typewriter', duration: 0.6 } })).toMatch(/letter by letter/);
    expect(splitBlocker({ ...base, animIn: { id: 'fade', duration: 0.6 } })).toBeNull();
  });
});

describe('modeBlocker', () => {
  it('right to left text only splits into lines', () => {
    const rtl = { text: 'שלום עולם' };
    expect(modeBlocker(rtl, 'letters')).toMatch(/right to left/);
    expect(modeBlocker(rtl, 'words')).toMatch(/right to left/);
    expect(modeBlocker(rtl, 'lines')).toBeNull();
    expect(modeBlocker({ text: 'hello' }, 'letters')).toBeNull();
  });
});

describe('splitNotes', () => {
  const base = createTextClip('t', 0, { text: 'hello there' });
  const key = (v: number) => [{ t: 0, v, ease: 'linear' as const }];

  it('nothing to say for a plain text', () => {
    expect(splitNotes(base)).toEqual([]);
  });

  it('animated size or turn: the pieces match at the playhead only', () => {
    expect(splitNotes({ ...base, keyframes: { scale: key(1) } })[0]).toMatch(/playhead only/);
    expect(splitNotes({ ...base, keyframes: { rotation: key(10) } })[0]).toMatch(/playhead only/);
    // a moving text is carried over exactly
    expect(splitNotes({ ...base, keyframes: { x: key(10) } })).toEqual([]);
    // tilt keys of a flat text do nothing
    expect(splitNotes({ ...base, keyframes: { rotX: key(10) } })).toEqual([]);
    expect(splitNotes({ ...base, threeD: true, keyframes: { rotX: key(10) } })[0]).toMatch(/playhead only/);
  });

  it('looks that are measured on the whole box are named', () => {
    expect(splitNotes({ ...base, gradient: { from: '#fff', to: '#000', angle: 0 } })).toEqual(['gradient now runs on every piece']);
    expect(splitNotes({ ...base, gradient: { from: '#fff', to: '#000', angle: 0 }, motionIn: { id: 'slide-left', duration: 0.5 } })).toEqual([
      'gradient / motion now run on every piece',
    ]);
  });
});
