/** keyboard helpers of the preview that are plain functions (tested without a dom) */
import { formatTimecode } from '../../lib/time';
import { clipEnd } from '../../lib/timelineOps';
import type { Project, VisualClip } from '../../types';
import { isVisualClip } from '../../types';

/**
 * the selected visual clips a preview drag / nudge may change at a time: on screen right now (inside their
 * range, track visible and unlocked). a selected clip that is not on screen at the playhead has no selection box
 * and must not get a stray keyframe written outside its range.
 */
export function movableClipsAt(project: Project, selection: readonly string[], time: number): VisualClip[] {
  const out: VisualClip[] = [];
  for (const c of project.clips) {
    if (!isVisualClip(c) || !selection.includes(c.id)) continue;
    if (!(time >= c.start - 1e-6 && time < clipEnd(c) - 1e-6)) continue;
    const track = project.tracks.find((t) => t.id === c.trackId);
    if (!track || track.locked || track.hidden) continue;
    out.push(c);
  }
  return out;
}

/** canvas pixels one arrow key press moves a clip: 1, or 10 with shift */
export function nudgeDelta(key: string, shift: boolean): [number, number] | null {
  const n = shift ? 10 : 1;
  switch (key) {
    case 'ArrowLeft':
      return [-n, 0];
    case 'ArrowRight':
      return [n, 0];
    case 'ArrowUp':
      return [0, -n];
    case 'ArrowDown':
      return [0, n];
    default:
      return null;
  }
}

/** <project>-<timecode>.png, safe on every file system (a timecode has colons) */
export function frameFileName(projectName: string, time: number, fps: number): string {
  const name =
    projectName
      .replace(/[\/:*?"<>|\x00-\x1f]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+/, '')
      .slice(0, 80) || 'ncut';
  return `${name}-${formatTimecode(time, fps).replace(/:/g, '-')}.png`;
}
