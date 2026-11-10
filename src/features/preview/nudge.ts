/** keyboard helpers of the preview that are plain functions (tested without a dom) */
import { formatTimecode } from '../../lib/time';

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
