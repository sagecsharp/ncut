/** the one mix rule: track faders, pan, solo and the output level, for the preview and the export alike. pure */
import type { AudioClip, MixOutput, Project, Track, VideoClip } from '../types';
import { isAnimated, valueAt } from './anim';
import { soundGainAt, type ClipSound } from './audioCross';
import { hasSoundApart, soundsOf } from './soundPair';
import { fadeFactor } from './timelineOps';

export const FADER_MAX_DB = 12;
export const MAX_TRACK_GAIN = 10 ** (FADER_MAX_DB / 20); // 3.9810717055349722
/** at or below this a level is off (-inf db) */
export const OFF_DB = -90;
const NEAR = 1e-4;
export type SoundClip = VideoClip | AudioClip;
const fit = (v: unknown, lo: number, hi: number, none: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : none;

export const trackVolume = (t: Track): number => fit(t.volume, 0, MAX_TRACK_GAIN, 1);
export const trackPan = (t: Track): number => fit(t.pan, -1, 1, 0);
export const outputGain = (p: Project): number => fit(p.output?.volume, 0, MAX_TRACK_GAIN, 1);
export const clipPan = (c: SoundClip): number => fit(c.pan, -1, 1, 0);
export function clipPanAt(c: SoundClip, time: number): number {
  const v = valueAt(c, 'pan', time);
  return v === undefined ? clipPan(c) : fit(v, -1, 1, 0);
}
/** balance: [left, right]. exactly [1, 1] at 0, the far side exactly 0 at ±1 */
export function panGains(p: number): readonly [number, number] {
  if (p > 0) return [p >= 1 ? 0 : Math.cos((p * Math.PI) / 2), 1];
  if (p < 0) return [1, p <= -1 ? 0 : Math.cos((-p * Math.PI) / 2)];
  return [1, 1];
}
export const needsPan = (trackPanValue: number, c: SoundClip): boolean => trackPanValue !== 0 || clipPan(c) !== 0 || isAnimated(c, 'pan');

export const NO_SOLO: readonly string[] = [];
/** the solo ids that still name a track, or null when no track is on solo */
export function soloSet(p: Project, solo: readonly string[]): ReadonlySet<string> | null {
  if (solo.length === 0) return null;
  const ids = new Set(solo.filter((id) => p.tracks.some((t) => t.id === id)));
  return ids.size > 0 ? ids : null;
}
export const soloActive = (p: Project | null | undefined, solo: readonly string[]): boolean => !!p && soloSet(p, solo) !== null;
/** mute wins, then solo */
export const trackHeard = (t: Track, solo: ReadonlySet<string> | null): boolean => !t.muted && (!solo || solo.has(t.id));

export interface ClipMix { gain: number; l: number; r: number; pan: boolean }
/** what one clip plays at a time in the preview. gain = keyed volume x fade x track fader, 0 when not heard */
export function clipMix(p: Project, c: SoundClip, time: number, solo: ReadonlySet<string> | null, sound: ClipSound | null = null): ClipMix {
  const t = p.tracks.find((x) => x.id === c.trackId);
  const tp = t ? trackPan(t) : 0;
  const pan = needsPan(tp, c);
  // in a crossfade's handles keyed pan and volume hold their edge values
  const vt = sound ? Math.min(c.start + c.duration, Math.max(c.start, time)) : time;
  let l = 1;
  let r = 1;
  if (pan) {
    const [cl, cr] = panGains(clipPanAt(c, vt));
    const [tl, tr] = panGains(tp);
    l = cl * tl;
    r = cr * tr;
  }
  if (!t || c.muted || !trackHeard(t, solo)) return { gain: 0, l, r, pan };
  if (sound) return { gain: soundGainAt(c, sound, time) * trackVolume(t), l, r, pan };
  const vol = Math.max(0, valueAt(c, 'volume', time) ?? c.volume);
  return { gain: vol * fadeFactor(c, time) * trackVolume(t), l, r, pan };
}

/** linear gain to db. -Infinity for no gain */
export const gainToDb = (g: number): number => (g > 0 ? 20 * Math.log10(g) : -Infinity);
/** db to linear gain: 0 at or below OFF_DB, never above +12 db. exactly 1 at 0 db */
export const dbToGain = (db: number): number => (db <= OFF_DB ? 0 : 10 ** (Math.min(db, FADER_MAX_DB) / 20));

const tenth = (db: number): number => Math.round(db * 10) / 10;
/** '-inf db', '+3.5 db', '0.0 db', '-6.0 db' (never '-0.0') */
export function formatDb(db: number): string {
  if (db <= OFF_DB) return '-inf db';
  const r = tenth(db);
  if (r === 0) return '0.0 db';
  return `${r > 0 ? '+' : ''}${r.toFixed(1)} db`;
}
/** '-inf', '0', '-6', '+3.5' */
export function formatDbShort(db: number): string {
  if (db <= OFF_DB) return '-inf';
  const r = tenth(db);
  if (r === 0) return '0';
  return `${r > 0 ? '+' : ''}${r}`;
}
/** 'middle', 'l40', 'r100' */
export function formatPan(p: number): string {
  const n = Math.round(Math.abs(p) * 100);
  if (n === 0) return 'middle';
  return `${p < 0 ? 'l' : 'r'}${n}`;
}
/** a typed level: '-6', '-6 db', '+3.5', 'off', '-inf', '50%'. at most +12 db. null for anything else */
export function parseDb(text: string): number | null {
  let s = text.trim().toLowerCase();
  if (s.endsWith('db')) s = s.slice(0, -2).trim();
  if (s === 'off' || s === '-inf' || s === 'inf' || s === '-∞') return -Infinity;
  const pct = /^(\d+(?:\.\d+)?|\.\d+)%$/.exec(s);
  if (pct) return Math.min(FADER_MAX_DB, gainToDb(Number(pct[1]) / 100));
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(s)) return Math.min(FADER_MAX_DB, Number(s));
  return null;
}

/** the tracks the mixer shows, in project order: every audio track, and every video track that holds a video clip with sound (not one whose sound is apart) or has a fader or pan set */
export function mixerTracks(p: Project): Track[] {
  const hasSound = new Set<string>();
  for (const c of p.clips) if (c.type === 'video' && p.assets.find((a) => a.id === c.assetId)?.hasAudio && !hasSoundApart(p.clips, c.id)) hasSound.add(c.trackId);
  return p.tracks.filter((t) => t.kind === 'audio' || hasSound.has(t.id) || t.volume !== undefined || t.pan !== undefined);
}

/** the distinct tracks of the clips in ids that have sound (an audio clip, a video clip whose media has audio), in project track order. a picture with its sound apart stands for the tracks of its sound clips */
export function soundTracksOf(p: Project, ids: Iterable<string>): string[] {
  const want = new Set(ids);
  const on = new Set<string>();
  for (const c of p.clips) {
    if (!want.has(c.id)) continue;
    if (c.type === 'video' && hasSoundApart(p.clips, c.id)) for (const s of soundsOf(p.clips, c)) on.add(s.trackId);
    else if (c.type === 'audio' || (c.type === 'video' && p.assets.find((a) => a.id === c.assetId)?.hasAudio)) on.add(c.trackId);
  }
  return p.tracks.filter((t) => on.has(t.id)).map((t) => t.id);
}

/** the solo list after a click on a track's S. only: this track alone (a second click ends it). else the track is added or taken out */
export function toggledSolo(solo: readonly string[], id: string, only: boolean): string[] {
  if (only) return solo.length === 1 && solo[0] === id ? [] : [id];
  return solo.includes(id) ? solo.filter((x) => x !== id) : [...solo, id];
}

/** no track has a fader or pan stored and the output is at 0 db */
export function isMixFlat(p: Project): boolean {
  if (p.output) return false;
  return !p.tracks.some((t) => t.volume !== undefined || t.pan !== undefined);
}

/** the short line of a track's sound for a header: its level, else its pan, else nothing */
export function trackSoundLine(t: Track): string {
  if (t.volume !== undefined) return `${formatDbShort(gainToDb(trackVolume(t)))} db`;
  if (t.pan !== undefined) return `pan ${formatPan(trackPan(t))}`;
  return '';
}

export interface TrackFields { name?: string; muted?: boolean; hidden?: boolean; locked?: boolean; syncLock?: boolean; volume?: number | null; pan?: number | null }
/** the track with the patch laid over it, cleaned, or null when nothing changes */
export function patchTrack(t: Track, patch: TrackFields): Track | null {
  const next: Track = { ...t };
  let changed = false;
  if (patch.name !== undefined && patch.name !== t.name) {
    next.name = patch.name;
    changed = true;
  }
  for (const k of ['muted', 'hidden', 'locked'] as const) {
    const v = patch[k];
    if (v !== undefined && v !== t[k]) {
      next[k] = v;
      changed = true;
    }
  }
  if (patch.syncLock === true && 'syncLock' in next) {
    delete next.syncLock;
    changed = true;
  } else if (patch.syncLock === false && t.syncLock !== false) {
    next.syncLock = false;
    changed = true;
  }
  const v = patch.volume;
  if (v === null || (typeof v === 'number' && Math.abs(v - 1) < NEAR)) {
    if ('volume' in next) {
      delete next.volume;
      changed = true;
    }
  } else if (typeof v === 'number' && !Number.isNaN(v)) {
    let g = Math.min(MAX_TRACK_GAIN, Math.max(0, v));
    if (g < 1e-5) g = 0;
    if (g !== (t.volume ?? 1)) {
      next.volume = g;
      changed = true;
    }
  }
  const p = patch.pan;
  if (p === null || (typeof p === 'number' && Math.abs(p) < NEAR)) {
    if ('pan' in next) {
      delete next.pan;
      changed = true;
    }
  } else if (typeof p === 'number' && !Number.isNaN(p)) {
    const q = Math.min(1, Math.max(-1, p));
    if (q !== (t.pan ?? 0)) {
      next.pan = q;
      changed = true;
    }
  }
  return changed ? next : null;
}

/** the output to store: prev itself when the level is the same, null when it is 0 db */
export function patchOutput(prev: MixOutput | null | undefined, next: MixOutput | null): MixOutput | null | undefined {
  const v = next ? fit(next.volume, 0, MAX_TRACK_GAIN, 1) : 1;
  if (Math.abs(v - 1) < NEAR) return prev === null || prev === undefined ? prev : null;
  const g = v < 1e-5 ? 0 : v;
  if (prev && prev.volume === g) return prev;
  return { volume: g };
}

/** every track volume and pan and the output back to neutral, mute and names kept. null when already flat */
export function planMixerReset(p: Project): Project | null {
  if (isMixFlat(p)) return null;
  const tracks = p.tracks.map((t) => {
    if (!('volume' in t) && !('pan' in t)) return t;
    const { volume: _v, pan: _p, ...rest } = t;
    return rest;
  });
  const { output: _o, ...rest } = p;
  return { ...rest, tracks };
}
