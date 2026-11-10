/**
 * "mark the beats" on a clip with sound: detect the beats from the cached waveform and put a
 * timeline marker on each one. one undo step. the markers carry the beat count as their name.
 *
 * clearing: Marker has no field to tag its origin (types.ts is not ours), so the ids this module
 * made are kept in a module map (lost on reload), and as a fallback a fresh detection is matched
 * against numbered markers inside the clip. limit: a hand made marker named with a number that
 * sits on a beat of this clip is removed too.
 */
import type { Clip, Project } from '../../types';
import { getWaveform } from '../../media/derived';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { beatsInClip, detectBeats, thinBeats } from './beats';

/** how many beats between markers: every beat, every 2nd, every 4th (bars) */
export type BeatDensity = 1 | 2 | 4;

/** marker ids made by "mark the beats", per clip id */
const made = new Map<string, Set<string>>();

/** true for audio clips and video clips whose asset has audio */
export function clipHasSound(project: Project | null | undefined, clip: Clip): boolean {
  if (clip.type === 'audio') return true;
  if (clip.type !== 'video') return false;
  return !!project?.assets.find((a) => a.id === clip.assetId)?.hasAudio;
}

type ClipBeats = { ok: true; beats: number[]; bpm: number } | { ok: false; reason: string } | null;

/**
 * beats of a clip in timeline seconds (all of them), or the reason there are none.
 * null = the clip is gone, has another asset or the open project changed while we waited: do nothing.
 */
async function clipBeats(clip: Clip, projectId: string): Promise<ClipBeats> {
  if (clip.type !== 'audio' && clip.type !== 'video') return null;
  const listening = setTimeout(() => useUi.getState().toast('listening...'), 400);
  let wf;
  try {
    wf = await getWaveform(clip.assetId);
  } finally {
    clearTimeout(listening);
  }
  // the clip may have moved (or be gone) while we waited: read it again
  const proj = useEditor.getState().project;
  if (!proj || proj.id !== projectId) return null;
  const now = proj.clips.find((c) => c.id === clip.id);
  if (!now || (now.type !== 'audio' && now.type !== 'video') || now.assetId !== clip.assetId) return null;
  if (!wf) return { ok: false, reason: 'could not read the audio' };
  const r = detectBeats(wf.peaks, wf.peaksPerSecond);
  if (r.reason !== 'ok') return { ok: false, reason: r.reason === 'no steady beat' ? 'no steady beat found' : r.reason };
  return { ok: true, beats: beatsInClip(r.beats, now), bpm: r.bpm };
}

/** put a marker on the beats of a clip. one undo step. */
export async function markBeats(clipId: string, density: BeatDensity = 1): Promise<void> {
  const st0 = useEditor.getState();
  const clip = st0.project?.clips.find((c) => c.id === clipId);
  if (!st0.project || !clip || !clipHasSound(st0.project, clip)) return;
  const fps = st0.project.fps ?? 30;
  const res = await clipBeats(clip, st0.project.id);
  if (!res) return;
  if (!res.ok) {
    useUi.getState().toast(res.reason);
    return;
  }
  if (res.beats.length === 0) {
    useUi.getState().toast('no beats inside this clip');
    return;
  }
  const st = useEditor.getState();
  const existing = st.project?.markers ?? [];
  const tol = 0.5 / fps;
  const wanted = thinBeats(res.beats, density);
  const fresh: { time: number; name: string }[] = [];
  wanted.forEach((time, i) => {
    // named by the place in the full beat list, so "every beat" after "every 4th" does not repeat names
    if (!existing.some((m) => Math.abs(m.time - time) <= tol)) fresh.push({ time, name: String(i * density + 1) });
  });
  if (fresh.length === 0) {
    useUi.getState().toast('the beats are already marked');
    return;
  }
  st.pushHistory();
  const ids = made.get(clipId) ?? new Set<string>();
  for (const f of fresh) ids.add(st.addMarker(f.time, f.name, { skipHistory: true }));
  made.set(clipId, ids);
  useUi.getState().toast(`${fresh.length} beats at ${Math.round(res.bpm)} bpm`);
}

/** remove the beat markers of this clip (see the header for how they are recognised). one undo step. */
export async function clearBeatMarkers(clipId: string): Promise<void> {
  const st0 = useEditor.getState();
  const clip = st0.project?.clips.find((c) => c.id === clipId);
  if (!st0.project || !clip || !clipHasSound(st0.project, clip)) return;
  const fps = st0.project.fps ?? 30;
  const res = await clipBeats(clip, st0.project.id);
  if (!res) return;
  const st = useEditor.getState();
  const markers = st.project?.markers ?? [];
  const mine = made.get(clipId);
  const tol = 0.5 / fps;
  const doomed = markers.filter(
    (m) =>
      mine?.has(m.id) || (res.ok && /^\d+$/.test(m.name) && res.beats.some((b) => Math.abs(b - m.time) <= tol)),
  );
  if (doomed.length === 0) {
    useUi.getState().toast('no beat markers here');
    return;
  }
  st.pushHistory();
  for (const m of doomed) st.removeMarker(m.id, { skipHistory: true });
  made.delete(clipId);
  useUi.getState().toast(`cleared ${doomed.length} markers`);
}
