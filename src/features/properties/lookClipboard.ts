import { useSyncExternalStore } from 'react';
import type { ClipType, VisualClip } from '../../types';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';

/** fields every visual clip shares (copied as is; a missing one becomes null = removed on paste) */
const COMMON_KEYS = ['blend', 'crop', 'radius', 'motionIn', 'motionOut', 'motionLoop', 'transition', 'adjust', 'chromaKey', 'motionBlur', 'mask'] as const;
/** only copied from a text clip to a text clip */
const TEXT_KEYS = [
  'color',
  'background',
  'fontFamily',
  'fontWeight',
  'italic',
  'letterSpacing',
  'lineHeight',
  'uppercase',
  'stroke',
  'shadow',
  'backgroundRadius',
  'backgroundPadding',
  'gradient',
  'curve',
  'wrapWidth',
  'animIn',
  'animOut',
  'animLoop',
  'stroke2',
  'highlight',
  'extrude',
  'underline',
  'strike',
  'hollow',
  'backgroundPerLine',
] as const;

export interface LookData {
  from: ClipType;
  opacity: number;
  values: Record<string, unknown>;
}

/** a copy of the look of a clip (deep, so later edits to the clip do not leak in) */
export function captureLook(clip: VisualClip): LookData {
  const src = clip as unknown as Record<string, unknown>;
  const values: Record<string, unknown> = {};
  for (const k of COMMON_KEYS) values[k] = src[k] === undefined ? null : structuredClone(src[k]);
  if (clip.type === 'text') for (const k of TEXT_KEYS) values[k] = src[k] === undefined ? null : structuredClone(src[k]);
  // where a cut left the lit words (offset / fullDuration) belongs to that clip, not to its look
  const hl = values.highlight as Record<string, unknown> | null | undefined;
  if (hl) {
    delete hl.offset;
    delete hl.fullDuration;
  }
  return { from: clip.type, opacity: clip.transform.opacity, values };
}

/** the fields of a look that apply to a clip of this type (text style only text to text) */
export function lookPatch(look: LookData, target: ClipType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const textToText = look.from === 'text' && target === 'text';
  for (const [k, v] of Object.entries(look.values)) {
    if ((TEXT_KEYS as readonly string[]).includes(k) && !textToText) continue;
    out[k] = v === null || v === undefined ? null : structuredClone(v);
  }
  // a green screen only exists on video and image
  if (target !== 'video' && target !== 'image') delete out.chromaKey;
  // text has its own box rounding, `radius` makes no sense there
  if (target === 'text') {
    delete out.radius;
    delete out.crop;
  }
  return out;
}

/* ---------- module level clipboard ---------- */

let current: LookData | null = null;
const listeners = new Set<() => void>();

export function copyLook(clip: VisualClip): void {
  current = captureLook(clip);
  for (const l of listeners) l();
}

export function getLook(): LookData | null {
  return current;
}

export function useLookClipboard(): LookData | null {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    getLook,
    getLook,
  );
}

/** paste the copied look on clips as ONE undo step */
export function pasteLook(ids: string[]): number {
  const look = current;
  const st = useEditor.getState();
  const p = st.project;
  if (!look || !p) return 0;
  const targets = p.clips.filter((c): c is VisualClip => ids.includes(c.id) && (c.type === 'video' || c.type === 'image' || c.type === 'text' || c.type === 'shape'));
  if (targets.length === 0) return 0;
  st.pushHistory();
  for (const c of targets) {
    st.updateClip(c.id, lookPatch(look, c.type) as ClipPatch, { skipHistory: true });
    st.updateTransform(c.id, { opacity: look.opacity }, { skipHistory: true });
  }
  return targets.length;
}
