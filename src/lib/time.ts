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
  // 3 frame digits once a second holds 100+ frames (120, 144, 165, 240 fps)
  const base = `${pad(m)}:${pad(s)}:${pad(f, Math.round(fps) > 100 ? 3 : 2)}`;
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

/** how times are shown in the transport and on the ruler */
export type TimeDisplay = 'timecode' | 'frames' | 'seconds';
export type TimeEntryError = 'bad' | 'frames-whole' | 'too-far' | 'zero';
/** a typed time in whole frames. at: go to that frame. by: move by that many */
export type ParsedTime =
  | { kind: 'empty'; relative: boolean }
  | { kind: 'error'; why: TimeEntryError }
  | { kind: 'at'; frame: number }
  | { kind: 'by'; frames: number };
/** the longest typed time or amount: one day */
export const MAX_ENTRY_SECONDS = 86400;

/** decimals that give every frame its own seconds text */
export function secondsDecimals(fps: number): number {
  return fps < 10 ? 1 : fps < 100 ? 2 : 3;
}

/** a time as the display shows it, frame snapped. timecode mode is formatTimecode itself */
export function formatTimeAs(t: number, fps: number, mode: TimeDisplay): string {
  if (mode === 'timecode') return formatTimecode(t, fps);
  const f = Math.round(fps);
  const n = Math.max(0, Math.round(t * f));
  return mode === 'frames' ? String(n) : `${(n / f).toFixed(secondsDecimals(f))}s`;
}

/** frames with their sign: '+12f', '-00:01:00', '+375f', '+12.50s'. in timecode mode it equals trim-modes' formatTrimDelta */
export function formatAmount(frames: number, fps: number, mode: TimeDisplay): string {
  const f = Math.round(fps);
  const n = Math.abs(Math.round(frames));
  const sign = frames > 0 ? '+' : frames < 0 ? '-' : '';
  if (n === 0) return '0f';
  if (mode === 'seconds') return `${sign}${(n / f).toFixed(secondsDecimals(f))}s`;
  if (mode === 'frames' || n < f) return `${sign}${n}f`;
  return sign + formatTimecode(n / f, f);
}

/** a ruler label. timecode mode is today's expression: the ruler stays pixel identical */
export function rulerLabelFor(t: number, fps: number, frameLabels: boolean, mode: TimeDisplay): string {
  if (mode === 'timecode') return frameLabels ? formatTimecode(t, fps) : formatDuration(t);
  const f = Math.round(fps);
  const n = Math.max(0, Math.round(t * f));
  return mode === 'frames' ? String(n) : `${+(n / f).toFixed(secondsDecimals(f))}s`;
}

const NUM = '(\\d+(?:\\.\\d*)?|\\.\\d+)';
const CLOCK_RE = /^\d+(?:[:;]\d+){1,3}$/;
const NUMBER_RE = /^(?:\d+(?:\.\d*)?|\.\d+)$/;
const UNITS_RE = new RegExp(`^(?:${NUM}h)?(?:${NUM}m)?(?:${NUM}s)?(?:(\\d+)f)?$`);
const UNITS_POINT_RE = new RegExp(`^(?:${NUM}h)?(?:${NUM}m)?(?:${NUM}s)?(?:${NUM}f)?$`);

/**
 * a typed time or amount in whole frames. a whole number is frames, a point means seconds, colons are a timecode read from
 * the right, h m s f are units, a leading + or - is an amount. rounds once, on the total
 */
export function parseTimeEntry(text: string, fps: number): ParsedTime {
  const f = Math.round(fps);
  let s = text.toLowerCase().trim();
  let relative = false;
  let sign = 1;
  if (s[0] === '+' || s[0] === '-' || s[0] === '−') {
    relative = true;
    sign = s[0] === '+' ? 1 : -1;
    s = s.slice(1);
  }
  s = s.replace(/[ \t_]/g, '');
  if (s === '') return { kind: 'empty', relative };
  let frames: number;
  if (CLOCK_RE.test(s)) {
    const parts = s.split(/[:;]/).map(Number);
    const [ff = 0, ss = 0, mm = 0, hh = 0] = parts.reverse();
    frames = ((hh * 60 + mm) * 60 + ss) * f + ff;
  } else if (NUMBER_RE.test(s)) {
    frames = s.includes('.') ? Math.round(Number(s) * f) : Number(s);
  } else {
    const m = UNITS_RE.exec(s);
    if (m && s !== '') {
      const [h, mi, sec, fr] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
      frames = Math.round((h! * 3600 + mi! * 60 + sec!) * f) + fr!;
    } else if (UNITS_POINT_RE.test(s)) return { kind: 'error', why: 'frames-whole' };
    else return { kind: 'error', why: 'bad' };
  }
  if (frames > MAX_ENTRY_SECONDS * f) return { kind: 'error', why: 'too-far' };
  if (relative) return frames === 0 ? { kind: 'error', why: 'zero' } : { kind: 'by', frames: sign * frames };
  return { kind: 'at', frame: frames };
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
