/**
 * the text animation of several text clips at once (the multi inspector). pure: what the row shows for the selection
 * and what each clip gets for a choice. the actions at the bottom write it as one undo step.
 */
import { useEditor } from '../../store/editorStore';
import type { TextAnim, TextClip } from '../../types';
import { liveOpts } from './edit';

export type TextAnimKey = 'animIn' | 'animOut' | 'animLoop';

/**
 * what one row shows: the animation every clip has (the first clip's duration), none when none has one, or mixed
 * when they differ in which animation they have (one with none counts as different)
 */
export function sharedTextAnim(clips: readonly Pick<TextClip, TextAnimKey>[], key: TextAnimKey): { value: TextAnim | null; mixed: boolean } {
  const first = clips[0]?.[key] ?? null;
  for (const c of clips) {
    const a = c[key] ?? null;
    if ((a?.id ?? null) !== (first?.id ?? null)) return { value: null, mixed: true };
  }
  return { value: first, mixed: false };
}

/**
 * the animation each clip gets when one is picked for all of them (null = none): a clip keeps its own duration when
 * it already had an animation there, else the default
 */
export function pickedFor(current: TextAnim | null | undefined, id: string | null, defaultDuration: number): TextAnim | null {
  if (id === null) return null;
  return { id, duration: current?.duration ?? defaultDuration };
}

/** pick an animation (or none) for every selected text clip: one undo step */
export function pickTextAnim(ids: readonly string[], key: TextAnimKey, id: string | null, defaultDuration: number): void {
  const st = useEditor.getState();
  const texts = textsOf(ids);
  if (texts.length === 0) return;
  st.pushHistory();
  for (const c of texts) st.updateClip(c.id, { [key]: pickedFor(c[key], id, defaultDuration) }, { skipHistory: true });
}

/** the same duration for every selected text clip that has an animation there. live = a scrub (one step per gesture) */
export function setTextAnimDuration(ids: readonly string[], key: TextAnimKey, duration: number, live: boolean): void {
  const st = useEditor.getState();
  const texts = textsOf(ids).filter((c) => c[key]);
  if (texts.length === 0) return;
  let opts = live ? liveOpts() : undefined;
  if (!live) {
    st.pushHistory();
    opts = { skipHistory: true };
  }
  for (const c of texts) st.updateClip(c.id, { [key]: { id: c[key]!.id, duration } }, opts);
}

function textsOf(ids: readonly string[]): TextClip[] {
  const want = new Set(ids);
  return (useEditor.getState().project?.clips ?? []).filter((c): c is TextClip => c.type === 'text' && want.has(c.id));
}
