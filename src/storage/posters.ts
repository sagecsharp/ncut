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

/** removes the posters of projects that are not in `known` (they only take space). returns how many went. */
export function pruneOrphanPosters(known: Iterable<string>): number {
  try {
    const keep = new Set<string>(known);
    const drop: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX) && !keep.has(k.slice(PREFIX.length))) drop.push(k);
    }
    for (const k of drop) localStorage.removeItem(k);
    return drop.length;
  } catch {
    return 0;
  }
}

/**
 * true when the sampled pixels (rgba, row by row, width x height) look like nothing was drawn: fully
 * transparent or one flat color. samples a grid of at most 8 x 8 points, so it costs nothing.
 */
export function isBlankPixels(data: ArrayLike<number>, width: number, height: number): boolean {
  if (!(width > 0) || !(height > 0) || data.length < width * height * 4) return true;
  const n = 8;
  let first: number[] | null = null;
  for (let gy = 0; gy < n; gy++) {
    for (let gx = 0; gx < n; gx++) {
      const x = Math.min(width - 1, Math.floor(((gx + 0.5) * width) / n));
      const y = Math.min(height - 1, Math.floor(((gy + 0.5) * height) / n));
      const i = (y * width + x) * 4;
      const px = [data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!];
      if (px[3] === 0) px[0] = px[1] = px[2] = 0;
      if (!first) first = px;
      else if (px.some((v, j) => Math.abs(v - first![j]!) > 2)) return false;
    }
  }
  return true;
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
    // nothing drawn yet (a project that was just opened): keep the old poster instead of a black frame
    if (isBlankPixels(ctx.getImageData(0, 0, w, h).data, w, h)) return null;
    const url = small.toDataURL('image/jpeg', 0.72);
    return isPoster(url) ? url : null;
  } catch {
    return null;
  }
}
