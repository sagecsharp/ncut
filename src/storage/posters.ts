/**
 * small poster pictures for the project cards. a poster is a jpeg data url of the preview, taken when a
 * project is closed or the tab is hidden. it is only a convenience, so it lives in localStorage (one key
 * per project, a few kb each) and every call may quietly do nothing when storage is blocked or full.
 */

const PREFIX = 'ncut.poster.';
/** the longer side of a poster in pixels */
export const POSTER_SIZE = 320;
/** a data url above this is not stored (localStorage is small) */
export const POSTER_MAX_CHARS = 60_000;

const key = (projectId: string): string => PREFIX + projectId;

/** the size a width x height picture is drawn at so its longer side is at most `max`. never upscales. */
export function posterSize(width: number, height: number, max = POSTER_SIZE): { w: number; h: number } {
  if (!(width > 0) || !(height > 0)) return { w: 0, h: 0 };
  const k = Math.min(1, max / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/** true for a string this module could have written */
export function isPoster(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('data:image/') && v.length <= POSTER_MAX_CHARS;
}

export function loadPoster(projectId: string): string | null {
  try {
    const v = localStorage.getItem(key(projectId));
    return isPoster(v) ? v : null;
  } catch {
    return null;
  }
}

export function savePoster(projectId: string, dataUrl: string): boolean {
  if (!isPoster(dataUrl)) return false;
  try {
    localStorage.setItem(key(projectId), dataUrl);
    return true;
  } catch {
    return false;
  }
}

export function deletePoster(projectId: string): void {
  try {
    localStorage.removeItem(key(projectId));
  } catch {
    // nothing to clean up
  }
}

export function copyPoster(fromId: string, toId: string): void {
  const v = loadPoster(fromId);
  if (v) savePoster(toId, v);
}

/** a small jpeg of what the canvas shows right now, or null when it cannot be read */
export function capturePoster(canvas: HTMLCanvasElement): string | null {
  try {
    const { w, h } = posterSize(canvas.width, canvas.height);
    if (w < 2 || h < 2) return null;
    const small = document.createElement('canvas');
    small.width = w;
    small.height = h;
    const ctx = small.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(canvas, 0, 0, w, h);
    const url = small.toDataURL('image/jpeg', 0.72);
    return isPoster(url) ? url : null;
  } catch {
    return null;
  }
}
