export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

/** snap a time to the nearest frame boundary */
export function snapToFrame(t: number, fps: number): number {
  return Math.round(t * fps) / fps;
}

export function frameDuration(fps: number): number {
  return 1 / fps;
}

function pad(n: number, len = 2): string {
  return String(n).padStart(len, '0');
}

/** 00:00:00:00 (hh:mm:ss:ff). hours are dropped when zero -> 00:00:00 (mm:ss:ff) */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps));
  const f = totalFrames % Math.round(fps);
  const totalSeconds = Math.floor(totalFrames / Math.round(fps));
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  const base = `${pad(m)}:${pad(s)}:${pad(f)}`;
  return h > 0 ? `${pad(h)}:${base}` : base;
}

/** 1:23 or 1:02:03. for durations in lists and ruler labels. */
export function formatDuration(t: number): string {
  const total = Math.max(0, Math.round(t));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** 1.5s / 12.25s style for short spans */
export function formatSeconds(t: number): string {
  return `${Math.round(t * 100) / 100}s`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  // pick the unit after rounding so 1048575 reads "1.0 MB", not "1024.0 KB"
  const kb = Math.round((n / 1024) * 10) / 10;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = Math.round((n / 1024 ** 2) * 10) / 10;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
