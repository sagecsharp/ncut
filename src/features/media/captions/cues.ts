/** captions <-> text clips. pure: no react, no store. */
import { createTextClip } from '../../../lib/factory';
import { MIN_CLIP_DURATION } from '../../../types';
import type { Clip, TextClip } from '../../../types';
import { splitIntoCues } from '../../../lib/subtitles';
import type { Cue } from '../../../lib/subtitles';

/** how a caption looks, as fractions of the project size */
export const CAPTION_Y = 0.38;
export const CAPTION_WRAP = 0.82;
export const CAPTION_SIZE = 0.045;

/** the first few words of a cue, for the clip name */
export function cueName(text: string, maxWords = 4, maxChars = 24): string {
  const words = text.split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ');
  if (!words) return 'caption';
  return words.length > maxChars ? words.slice(0, maxChars - 1).trimEnd() + '…' : words;
}

/** the style of a caption in a project of this size: bottom center, wrapped, white with a dark outline */
export function captionStyle(width: number, height: number): Partial<TextClip> {
  return {
    fontSize: Math.max(8, Math.round(height * CAPTION_SIZE)),
    fontWeight: 700,
    color: '#ffffff',
    background: null,
    align: 'center',
    wrapWidth: Math.round(width * CAPTION_WRAP),
    stroke: { color: '#000000', width: 0.1 },
    transform: { x: 0, y: Math.round(height * CAPTION_Y), scale: 1, rotation: 0, opacity: 1 },
  };
}

/** one text clip per cue (cues shorter than the smallest clip are skipped). the track id is a placeholder for addClips. */
export function cuesToClips(cues: Cue[], width: number, height: number, trackId = ''): TextClip[] {
  const style = captionStyle(width, height);
  const out: TextClip[] = [];
  for (const c of cues) {
    const duration = c.end - c.start;
    if (!(duration >= MIN_CLIP_DURATION) || !c.text.trim()) continue;
    out.push(createTextClip(trackId, c.start, { ...style, name: cueName(c.text), text: c.text, duration }));
  }
  return out;
}

/** every text clip as a cue, sorted by start (overlapping ones all stay) */
export function clipsToCues(clips: Clip[]): Cue[] {
  const out: Cue[] = [];
  for (const c of clips) {
    if (c.type !== 'text') continue;
    const text = c.text.replace(/\r\n?/g, '\n').trim();
    if (!text) continue;
    out.push({ start: c.start, end: c.start + c.duration, text });
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => a.c.start - b.c.start || a.i - b.i).map((x) => x.c);
}

/**
 * a text clip cut into caption sized clips over the same time range, in the same style. [] when it would stay
 * one piece (nothing to split). the pieces drop the group and keyframes of the original (an attachment to a parent stays).
 */
export function splitTextClip(clip: TextClip, maxChars = 42): TextClip[] {
  const cues = splitIntoCues(clip.text, clip.start, clip.duration, maxChars);
  if (cues.length < 2) return [];
  const pieces: TextClip[] = [];
  for (const c of cues) {
    const duration = c.end - c.start;
    if (!(duration >= MIN_CLIP_DURATION)) continue;
    const piece: TextClip = { ...clip, name: cueName(c.text), text: c.text, start: c.start, duration };
    delete piece.group;
    delete piece.keyframes;
    pieces.push(piece);
  }
  return pieces.length >= 2 ? pieces : [];
}

/** a guessed reading pace for a pasted transcript */
export const CAPTION_CHARS_PER_SECOND = 15;
/** a line of the transcript never gets less time than this (seconds) */
export const MIN_LINE_SECONDS = 1;

/**
 * a pasted transcript as timed cues from `start` on. every non-empty line starts a new caption; a long line is cut
 * into caption sized pieces (splitIntoCues). each line lasts length / charsPerSecond (at least MIN_LINE_SECONDS),
 * back to back, so the pace is about charsPerSecond everywhere. [] for an empty transcript.
 */
export function transcriptToCues(text: string, start: number, charsPerSecond = CAPTION_CHARS_PER_SECOND, maxChars = 42): Cue[] {
  const cps = charsPerSecond > 0 ? charsPerSecond : CAPTION_CHARS_PER_SECOND;
  const out: Cue[] = [];
  let t = Math.max(0, start);
  for (const raw of String(text ?? '').split(/\r\n?|\n/)) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    const duration = Math.max(MIN_LINE_SECONDS, line.length / cps);
    out.push(...splitIntoCues(line, t, duration, maxChars));
    t += duration;
  }
  return out;
}
