/** subtitle files (.srt / .vtt): parsing, writing, and cutting a long text into caption sized pieces. pure. */

export interface Cue {
  /** seconds */
  start: number;
  end: number;
  text: string;
}

const TS = String.raw`(?:\d+:)?\d{1,2}:\d{2}(?:[.,]\d+)?`;
const TIMING = new RegExp(String.raw`^\s*(${TS})\s*-->\s*(${TS})`);

/** "00:01:02,500", "1:02.5", "01:02" (minutes:seconds) -> seconds, NaN when it is not a time */
function parseStamp(s: string): number {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d+))?$/.exec(s.trim());
  if (!m) return NaN;
  const h = m[1] ? Number(m[1]) : 0;
  const frac = m[4] ? Number('0.' + m[4]) : 0;
  return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

/** drop tags and style overrides, decode the few entities, trim every line, drop empty lines */
function cleanText(lines: string[]): string {
  const out: string[] = [];
  for (const raw of lines) {
    const t = raw
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#\d+|[a-z]+);/gi, (all, name: string) => {
        if (name[0] === '#') {
          const code = Number(name.slice(1));
          return code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
        }
        const v = ENTITIES[name.toLowerCase()];
        return v === undefined ? all : v;
      })
      .trim();
    if (t) out.push(t);
  }
  return out.join('\n');
}

/**
 * read an .srt or .vtt file (told apart by the content, not the name). never throws: anything unreadable gives [].
 * cues without text or without a positive length are dropped, the rest is sorted by start.
 */
export function parseSubtitles(text: string): Cue[] {
  if (typeof text !== 'string') return [];
  try {
    const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
    const cues: Cue[] = [];
    let cur: { start: number; end: number; lines: string[] } | null = null;
    const flush = (): void => {
      if (!cur) return;
      const t = cleanText(cur.lines);
      if (t && cur.end > cur.start && cur.start >= 0 && Number.isFinite(cur.start) && Number.isFinite(cur.end)) {
        cues.push({ start: cur.start, end: cur.end, text: t });
      }
      cur = null;
    };
    for (const line of lines) {
      const tm = TIMING.exec(line);
      if (tm) {
        const start = parseStamp(tm[1]!);
        const end = parseStamp(tm[2]!);
        if (cur) {
          // no blank line before this cue: a lone number at the end of the last one is this cue's index
          if (cur.lines.length > 0 && /^\s*\d+\s*$/.test(cur.lines[cur.lines.length - 1]!)) cur.lines.pop();
          flush();
        }
        cur = { start, end, lines: [] };
      } else if (cur) {
        if (line.trim() === '') flush();
        else cur.lines.push(line);
      }
    }
    flush();
    return cues.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map((x) => x.c);
  } catch {
    return [];
  }
}

function pad(n: number, len: number): string {
  return String(n).padStart(len, '0');
}

/** seconds -> HH:MM:SS,mmm */
export function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round((Number.isFinite(seconds) ? seconds : 0) * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

/** cues as an .srt file: 1-based index, times, text, a blank line between */
export function toSrt(cues: Cue[]): string {
  if (cues.length === 0) return '';
  return (
    cues
      .map((c, i) => {
        // a blank line inside a cue would end it early
        const text = c.text
          .replace(/\r\n?/g, '\n')
          .split('\n')
          .filter((l) => l.trim() !== '')
          .join('\n');
        return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${text}`;
      })
      .join('\n\n') + '\n'
  );
}

/* ---------- cutting a text into caption sized pieces ---------- */

const SENTENCE = /(?<=[.!?…]["')\]]*)\s+/;
const COMMA = /(?<=[,;:—])\s+/;

/** join units greedily into pieces of at most max letters. a unit that is too long is cut by `deeper`. */
function pack(units: string[], max: number, deeper: (s: string) => string[]): string[] {
  const out: string[] = [];
  let cur = '';
  for (const u of units) {
    if (!u) continue;
    if (u.length > max) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
      const parts = deeper(u);
      for (let i = 0; i < parts.length - 1; i++) out.push(parts[i]!);
      cur = parts[parts.length - 1] ?? '';
      continue;
    }
    if (!cur) cur = u;
    else if (cur.length + 1 + u.length <= max) cur += ' ' + u;
    else {
      out.push(cur);
      cur = u;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function byWords(s: string, max: number): string[] {
  return pack(s.split(' '), max, (w) => [w]);
}
function byCommas(s: string, max: number): string[] {
  return pack(s.split(COMMA), max, (p) => byWords(p, max));
}
function bySentences(s: string, max: number): string[] {
  return pack(s.split(SENTENCE), max, (p) => byCommas(p, max));
}

/**
 * cut a text into pieces of at most maxChars letters (a single longer word stays whole): at sentence ends first, then
 * commas, then between words. every piece gets a share of `duration` proportional to its length, back to back from `start`.
 */
export function splitIntoCues(text: string, start: number, duration: number, maxChars = 42): Cue[] {
  const flat = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return [];
  const max = Math.max(1, Math.floor(maxChars) || 42);
  const pieces = flat.length <= max ? [flat] : bySentences(flat, max);
  const total = pieces.reduce((n, p) => n + p.length, 0) || 1;
  const end = start + duration;
  const cues: Cue[] = [];
  let acc = 0;
  let t = start;
  for (let i = 0; i < pieces.length; i++) {
    const p = pieces[i]!;
    acc += p.length;
    const e = i === pieces.length - 1 ? end : start + (duration * acc) / total;
    cues.push({ start: t, end: e, text: p });
    t = e;
  }
  return cues;
}
