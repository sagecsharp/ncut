import type {
  AudioClip,
  CameraClip,
  ClipParts,
  ClipTake,
  EffectClip,
  ImageClip,
  InOutRange,
  MediaAsset,
  Project,
  ShapeClip,
  TextClip,
  Track,
  TrackKind,
  VideoClip,
} from '../types';
import { DEFAULT_TRANSFORM, MIN_CLIP_DURATION } from '../types';
import { uid } from './id';
import { cleanRange } from './inOut';
import { clamp } from './time';

export interface CanvasPreset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export const CANVAS_PRESETS: CanvasPreset[] = [
  { id: '16:9', label: '16:9 landscape (1920x1080)', width: 1920, height: 1080 },
  { id: '9:16', label: '9:16 vertical (1080x1920)', width: 1080, height: 1920 },
  { id: '1:1', label: '1:1 square (1080x1080)', width: 1080, height: 1080 },
  { id: '4:3', label: '4:3 classic (1440x1080)', width: 1440, height: 1080 },
  { id: '4:5', label: '4:5 portrait (1080x1350)', width: 1080, height: 1350 },
  { id: '21:9', label: '21:9 ultrawide (2560x1080)', width: 2560, height: 1080 },
];

/** frame rates offered for the project and for export */
export const FPS_OPTIONS = [24, 25, 30, 50, 60, 90, 120, 144, 165, 240];
export const MAX_FPS = 240;

export const DEFAULT_IMAGE_DURATION = 5;
export const DEFAULT_TEXT_DURATION = 4;
export const DEFAULT_EFFECT_DURATION = 3;
export const DEFAULT_CAMERA_DURATION = 5;

export const FONT_FAMILIES = [
  'Kode Mono',
  'Ubuntu',
  'Noto Sans',
  'Arial',
  'Helvetica',
  'Georgia',
  'Times New Roman',
  'Courier New',
  'Verdana',
  'Trebuchet MS',
  'Impact',
  'Comic Sans MS',
];

export function createTrack(kind: TrackKind, name: string): Track {
  return { id: uid('trk'), kind, name, muted: false, hidden: false, locked: false };
}

export function createProject(name = 'untitled project', preset: CanvasPreset = CANVAS_PRESETS[0]!, fps = 30): Project {
  const now = Date.now();
  return {
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    width: preset.width,
    height: preset.height,
    fps,
    background: '#000000',
    assets: [],
    tracks: [createTrack('video', 'video 1'), createTrack('audio', 'audio 1')],
    clips: [],
  };
}

/** the clip type a media gives for what is taken of it: null when the media has none of that part */
export function clipTypeFor(a: Pick<MediaAsset, 'kind' | 'hasAudio'>, parts: ClipParts = 'both'): 'video' | 'audio' | 'image' | null {
  if (a.kind === 'lut') return null;
  if (parts === 'sound') return a.kind === 'audio' || (a.kind === 'video' && a.hasAudio) ? 'audio' : null;
  if (parts === 'picture') return a.kind === 'audio' ? null : a.kind;
  return a.kind;
}

/** where in the file a new clip starts and how long it is: the marked range, widened to the smallest clip. no range = the whole file */
export function clipRange(a: Pick<MediaAsset, 'kind' | 'duration'>, range?: InOutRange | null): { trimStart: number; duration: number } {
  if (a.kind === 'image') return { trimStart: 0, duration: DEFAULT_IMAGE_DURATION };
  const r = cleanRange(range);
  if (!r || a.duration < MIN_CLIP_DURATION) return { trimStart: 0, duration: Math.max(a.duration, 0.1) };
  let s = clamp(r.in ?? 0, 0, a.duration);
  let e = clamp(r.out ?? a.duration, 0, a.duration);
  if (e - s < MIN_CLIP_DURATION) {
    e = Math.min(a.duration, s + MIN_CLIP_DURATION);
    s = Math.max(0, e - MIN_CLIP_DURATION);
  }
  return { trimStart: s, duration: e - s };
}

export function createClipFromAsset(
  asset: MediaAsset,
  trackId: string,
  start: number,
  take?: ClipTake,
): VideoClip | ImageClip | AudioClip {
  if (asset.kind === 'lut') throw new Error('a lut is not a clip');
  const base = { id: uid('clp'), trackId, start, name: asset.name, fadeIn: 0, fadeOut: 0 };
  const type = clipTypeFor(asset, take?.parts) ?? asset.kind;
  if (type === 'video') {
    const { trimStart, duration } = clipRange(asset, take?.range);
    return {
      ...base,
      type: 'video',
      assetId: asset.id,
      duration,
      trimStart,
      speed: 1,
      volume: 1,
      muted: take?.parts === 'picture' && asset.hasAudio,
      transform: { ...DEFAULT_TRANSFORM },
    };
  }
  if (type === 'audio') {
    const { trimStart, duration } = clipRange(asset, take?.range);
    return {
      ...base,
      type: 'audio',
      assetId: asset.id,
      duration,
      trimStart,
      speed: 1,
      volume: 1,
      muted: false,
    };
  }
  return {
    ...base,
    type: 'image',
    assetId: asset.id,
    duration: DEFAULT_IMAGE_DURATION,
    transform: { ...DEFAULT_TRANSFORM },
  };
}

export function createTextClip(trackId: string, start: number, overrides: Partial<TextClip> = {}): TextClip {
  return {
    id: uid('clp'),
    type: 'text',
    trackId,
    start,
    duration: DEFAULT_TEXT_DURATION,
    name: 'text',
    fadeIn: 0,
    fadeOut: 0,
    text: 'your text',
    fontFamily: 'Kode Mono',
    fontSize: 96,
    fontWeight: 700,
    italic: false,
    color: '#ffffff',
    background: null,
    align: 'center',
    transform: { ...DEFAULT_TRANSFORM },
    ...overrides,
  };
}

export const DEFAULT_SHAPE_DURATION = 4;

/** a shape clip: a white square by default */
export function createShapeClip(trackId: string, start: number, overrides: Partial<ShapeClip> = {}): ShapeClip {
  return {
    id: uid('clp'),
    type: 'shape',
    trackId,
    start,
    duration: DEFAULT_SHAPE_DURATION,
    name: overrides.kind ?? 'rect',
    fadeIn: 0,
    fadeOut: 0,
    kind: 'rect',
    width: 400,
    height: 400,
    color: '#ffffff',
    transform: { ...DEFAULT_TRANSFORM },
    ...overrides,
  };
}

/** an effect clip. `effect` is an id from engine/effects/registry. params missing here use the effect defaults. */
export function createEffectClip(
  effect: string,
  name: string,
  trackId: string,
  start: number,
  overrides: Partial<EffectClip> = {},
): EffectClip {
  return {
    id: uid('clp'),
    type: 'effect',
    trackId,
    start,
    duration: DEFAULT_EFFECT_DURATION,
    name,
    fadeIn: 0,
    fadeOut: 0,
    effect,
    amount: 1,
    params: {},
    seed: Math.floor(Math.random() * 1000),
    ...overrides,
  };
}

/** a camera clip at the home pose (changes nothing until it is moved) */
export function createCameraClip(trackId: string, start: number, overrides: Partial<CameraClip> = {}): CameraClip {
  return {
    id: uid('clp'),
    type: 'camera',
    trackId,
    start,
    duration: DEFAULT_CAMERA_DURATION,
    name: 'camera',
    fadeIn: 0,
    fadeOut: 0,
    x: 0,
    y: 0,
    z: 0,
    pan: 0,
    tilt: 0,
    roll: 0,
    fov: 50,
    ...overrides,
  };
}
