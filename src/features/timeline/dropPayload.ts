/** what a drag payload means for the timeline: its lane kind, length, label and take. pure, moved out of dnd.ts */
import type { ClipParts, InOutRange, MediaAsset, TrackKind } from '../../types';
import { trackKindForClip } from '../../types';
import { DEFAULT_CAMERA_DURATION, DEFAULT_EFFECT_DURATION, DEFAULT_SHAPE_DURATION, DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION, clipRange, clipTypeFor } from '../../lib/factory';
import type { DragPayload } from '../../lib/dnd';
import { getEffect } from '../../engine/effects/registry';
import { getTransition } from '../../engine/transitions/registry';

export function kindOfPayload(payload: DragPayload, assets: MediaAsset[]): TrackKind | null {
  if (payload.kind === 'text' || payload.kind === 'shape' || payload.kind === 'effect' || payload.kind === 'camera') return 'video';
  // transitions go on a clip, not on a lane
  if (payload.kind === 'transition') return null;
  const asset = assets.find((a) => a.id === payload.assetId);
  if (!asset) return null;
  const t = clipTypeFor(asset, payload.parts);
  return t === null ? null : trackKindForClip(t);
}

export function durationOfPayload(payload: DragPayload, assets: MediaAsset[]): number {
  if (payload.kind === 'text') {
    const d = payload.preset?.duration;
    return typeof d === 'number' && d > 0 ? d : DEFAULT_TEXT_DURATION;
  }
  if (payload.kind === 'shape') {
    const d = payload.preset?.duration;
    return typeof d === 'number' && d > 0 ? d : DEFAULT_SHAPE_DURATION;
  }
  if (payload.kind === 'effect') return DEFAULT_EFFECT_DURATION;
  if (payload.kind === 'camera') return DEFAULT_CAMERA_DURATION;
  if (payload.kind === 'transition') return 1;
  const asset = assets.find((a) => a.id === payload.assetId);
  if (!asset) return 1;
  return clipRange(asset, payload.range).duration;
}

export function ghostLabel(payload: DragPayload | null): string {
  if (!payload) return '';
  if (payload.kind === 'camera') return 'camera';
  if (payload.kind === 'shape') return payload.preset?.name ?? payload.preset?.kind ?? 'rect';
  if (payload.kind === 'transition') return getTransition(payload.transition)?.name ?? payload.transition;
  if (payload.kind === 'asset') {
    if (payload.parts === 'picture') return 'picture only';
    if (payload.parts === 'sound') return 'sound only';
    return '';
  }
  if (payload.kind !== 'effect') return '';
  return getEffect(payload.effect)?.name ?? payload.effect;
}

/** the part of a media a dropped asset takes: only the keys that are set */
export function takeOf(payload: DragPayload): { range?: InOutRange; parts?: ClipParts } {
  if (payload.kind !== 'asset') return {};
  return {
    ...(payload.range !== undefined ? { range: payload.range } : {}),
    ...(payload.parts !== undefined ? { parts: payload.parts } : {}),
  };
}
