/**
 * the tempo of a clip with sound: listen for it (detect), and who can lend a beat grid to the keyframes of
 * another clip (beat sources).
 */
import { type BeatGrid, clipGrid, settleBpm, showBpm, timelineBpm } from '../../lib/tempo';
import { getWaveform } from '../../media/derived';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { Clip, Project } from '../../types';
import { clipHasSound } from './beatActions';
import { detectBeats } from './beats';

/** find the tempo of a clip's sound and store it on the clip (bpm and where a beat falls). one undo step. */
export async function detectBpm(clipId: string): Promise<void> {
  const st0 = useEditor.getState();
  const project = st0.project;
  const clip = project?.clips.find((c) => c.id === clipId);
  if (!project || !clip || (clip.type !== 'audio' && clip.type !== 'video') || !clipHasSound(project, clip)) return;
  const ui = useUi.getState();
  if (project.tracks.find((t) => t.id === clip.trackId)?.locked) {
    ui.toast('this track is locked', 'info');
    return;
  }
  const listening = setTimeout(() => useUi.getState().toast('listening...'), 400);
  let wf;
  try {
    wf = await getWaveform(clip.assetId);
  } catch {
    wf = null;
  } finally {
    clearTimeout(listening);
  }
  // the clip may be gone or carry another sound by now
  const now = useEditor.getState().project;
  const cur = now?.clips.find((c) => c.id === clipId);
  if (!now || now.id !== project.id || !cur || (cur.type !== 'audio' && cur.type !== 'video') || cur.assetId !== clip.assetId) return;
  // it may also have been locked meanwhile (or moved to a locked track)
  if (now.tracks.find((t) => t.id === cur.trackId)?.locked) {
    ui.toast('this track is locked', 'info');
    return;
  }
  if (!wf) {
    ui.toast('could not read the audio', 'error');
    return;
  }
  const r = detectBeats(wf.peaks, wf.peaksPerSecond);
  const bpm = r.reason === 'ok' ? settleBpm(r.bpm, wf.peaks.length / wf.peaksPerSecond, wf.peaksPerSecond) : null;
  if (bpm === null) {
    const why = r.reason === 'ok' || r.reason === 'no steady beat' ? 'no steady beat found' : r.reason;
    ui.toast(`${why}. type the bpm in, or tap it`, 'info');
    return;
  }
  useEditor.getState().updateClip(clipId, { bpm, beatOffset: r.offset });
  // say what the clip has now, not what was meant to be written
  const after = useEditor.getState().project?.clips.find((c) => c.id === clipId);
  const stored = after && (after.type === 'audio' || after.type === 'video') ? after.bpm : null;
  if (stored != null) ui.toast(`${showBpm(stored)} bpm`);
}

export interface BeatSource {
  id: string;
  label: string;
  /** timeline seconds */
  grid: BeatGrid;
}

/**
 * the clips whose tempo can drive the keyframes of `clip`: every clip with sound and a bpm. the clip itself
 * comes first, then the ones that play at the same time (the longest overlap first), then the rest by time.
 */
export function beatSources(project: Project, clip: Pick<Clip, 'id' | 'start' | 'duration'>): BeatSource[] {
  const end = clip.start + clip.duration;
  const found: Array<BeatSource & { rank: number; start: number }> = [];
  for (const c of project.clips) {
    if (c.type !== 'audio' && c.type !== 'video') continue;
    const grid = clipGrid(c);
    if (!grid || !clipHasSound(project, c)) continue;
    const overlap = Math.max(0, Math.min(end, c.start + c.duration) - Math.max(clip.start, c.start));
    const name = c.name || project.assets.find((a) => a.id === c.assetId)?.name || c.type;
    found.push({ id: c.id, label: `${name} · ${timelineBpm(c)} bpm`, grid, rank: c.id === clip.id ? Infinity : overlap, start: c.start });
  }
  found.sort((a, b) => b.rank - a.rank || a.start - b.start);
  return found.map(({ id, label, grid }) => ({ id, label, grid }));
}
