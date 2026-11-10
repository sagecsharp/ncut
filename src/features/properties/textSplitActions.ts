import { measureText, textFont } from '../../engine/text';
import type { TextBox, TextGlyph } from '../../engine/text';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { TextClip } from '../../types';
import { MAX_PIECES, keepsBackground, layoutGlyphsFrom, pieceClip, splitBlocker, splitPlan } from './textSplit';
import type { SplitMode, SplitPlan } from './textSplit';

export const SPLIT_MODES: SplitMode[] = ['letters', 'words', 'lines'];

type Ctx2d = { font: string; measureText(s: string): { width: number } };
let measureCtx: Ctx2d | null = null;
function getCtx(): Ctx2d | null {
  if (measureCtx) return measureCtx;
  if (typeof OffscreenCanvas !== 'undefined') measureCtx = new OffscreenCanvas(8, 8).getContext('2d');
  if (!measureCtx && typeof document !== 'undefined') measureCtx = document.createElement('canvas').getContext('2d');
  return measureCtx;
}

/**
 * the laid out letters of a text clip as it is drawn at rest. the drawing code fills the box's glyph cache only when
 * letters are drawn one by one, so when it is empty the same layout is rebuilt here from the line edges.
 */
function layoutOf(clip: TextClip, box: TextBox): TextGlyph[] | null {
  if (box.glyphCache) return box.glyphCache.glyphs;
  let edges = box.edges;
  if (!edges) {
    const ctx = getCtx();
    if (!ctx) return null;
    ctx.font = textFont(clip);
    edges = box.lines.map((line) => {
      const e = [0];
      let acc = '';
      for (const ch of line) {
        acc += ch;
        e.push(ctx.measureText(acc).width);
      }
      return e;
    });
  }
  return layoutGlyphsFrom(box, clip.align, edges);
}

/** the plan of every mode for a text clip (what the buttons show). null when the text cannot be laid out. */
export function splitPlans(clip: TextClip): Record<SplitMode, SplitPlan> | null {
  const box = measureText(clip);
  const glyphs = layoutOf(clip, box);
  if (!glyphs) return null;
  return { letters: splitPlan(box, glyphs, 'letters'), words: splitPlan(box, glyphs, 'words'), lines: splitPlan(box, glyphs, 'lines') };
}

/** why a mode does nothing for this plan, or null when it can run */
export function splitReason(plan: SplitPlan | undefined): string | null {
  if (!plan || plan.count < 2) return 'nothing to split';
  if (plan.count > MAX_PIECES) return `too many pieces (${plan.count}), try words or lines`;
  return null;
}

const plural = (n: number, mode: SplitMode) => `${n} ${n === 1 ? mode.slice(0, -1) : mode}`;

/**
 * split a text clip into one clip per letter / word / line, each where its piece was. one undo step.
 * the pieces replace the original, are grouped and selected. returns how many pieces were made (0 = nothing happened).
 */
export function splitText(id: string, mode: SplitMode): number {
  const st = useEditor.getState();
  const ui = useUi.getState();
  const p = st.project;
  const clip = p?.clips.find((c) => c.id === id);
  if (!p || !clip || clip.type !== 'text') return 0;
  if (p.tracks.find((t) => t.id === clip.trackId)?.locked) return 0;
  const blocked = splitBlocker(clip);
  if (blocked) {
    ui.toast(blocked);
    return 0;
  }
  const plans = splitPlans(clip);
  const plan = plans?.[mode];
  const reason = splitReason(plan);
  if (!plan || reason) {
    ui.toast(reason ?? 'nothing to split');
    return 0;
  }
  // offsets are worked out with the clip's scale / spin at the playhead (held inside the clip)
  const time = clamp(usePlayback.getState().time, clip.start, clip.start + clip.duration);
  const effects = p.clips.filter((c) => c.type === 'effect' && c.target === id).length;
  const pieces = plan.pieces.map((pc) => pieceClip(clip, pc, mode, time));

  st.pushHistory();
  const skip = { skipHistory: true };
  st.deleteClips([id], skip);
  // the original is gone, so its track is free again: the first piece takes it, the others find room on other tracks
  const made = st.addClips(pieces, { newTrack: false, skipHistory: true });
  if (made.length === 0) {
    st.undo();
    return 0;
  }
  st.groupClips(made, skip);
  st.select(made, 'replace');
  let msg = plural(made.length, mode);
  if (clip.background && !keepsBackground(mode)) msg += ', background removed';
  if (effects > 0) msg += `, ${effects === 1 ? 'its effect was' : `${effects} effects were`} removed`;
  ui.toast(msg);
  return made.length;
}
