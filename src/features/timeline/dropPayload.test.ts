import { describe, expect, it } from 'vitest';
import type { MediaAsset } from '../../types';
import { DEFAULT_CAMERA_DURATION, DEFAULT_EFFECT_DURATION, DEFAULT_IMAGE_DURATION, DEFAULT_SHAPE_DURATION, DEFAULT_TEXT_DURATION } from '../../lib/factory';
import type { DragPayload } from '../../lib/dnd';
import { getEffect } from '../../engine/effects/registry';
import { durationOfPayload, ghostLabel, kindOfPayload, takeOf } from './dropPayload';

const media = (id: string, kind: MediaAsset['kind'], duration: number, hasAudio: boolean): MediaAsset => ({
  id, name: id, kind, mime: 'x/x', size: 1, duration, width: 100, height: 100, hasAudio, createdAt: 0,
});
const assets = [media('talk', 'video', 10, true), media('mute', 'video', 10, false), media('song', 'audio', 20, true), media('pic', 'image', 0, false)];
const asset = (assetId: string, more: Partial<Extract<DragPayload, { kind: 'asset' }>> = {}): DragPayload => ({ kind: 'asset', assetId, ...more });

describe('dropPayload', () => {
  it('old payloads unchanged', () => {
    const fx: DragPayload = { kind: 'effect', effect: 'shake' };
    expect(kindOfPayload({ kind: 'text' }, assets)).toBe('video');
    expect(kindOfPayload({ kind: 'shape' }, assets)).toBe('video');
    expect(kindOfPayload(fx, assets)).toBe('video');
    expect(kindOfPayload({ kind: 'camera' }, assets)).toBe('video');
    expect(kindOfPayload({ kind: 'transition', transition: 'fade' }, assets)).toBeNull();
    expect(kindOfPayload(asset('talk'), assets)).toBe('video');
    expect(kindOfPayload(asset('song'), assets)).toBe('audio');
    expect(kindOfPayload(asset('pic'), assets)).toBe('video');
    expect(kindOfPayload(asset('gone'), assets)).toBeNull();
    expect(durationOfPayload({ kind: 'text' }, assets)).toBe(DEFAULT_TEXT_DURATION);
    expect(durationOfPayload({ kind: 'text', preset: { duration: 3 } }, assets)).toBe(3);
    expect(durationOfPayload({ kind: 'shape' }, assets)).toBe(DEFAULT_SHAPE_DURATION);
    expect(durationOfPayload({ kind: 'shape', preset: { duration: 2 } }, assets)).toBe(2);
    expect(durationOfPayload(fx, assets)).toBe(DEFAULT_EFFECT_DURATION);
    expect(durationOfPayload({ kind: 'camera' }, assets)).toBe(DEFAULT_CAMERA_DURATION);
    expect(durationOfPayload({ kind: 'transition', transition: 'fade' }, assets)).toBe(1);
    expect(durationOfPayload(asset('talk'), assets)).toBe(10);
    expect(durationOfPayload(asset('song'), assets)).toBe(20);
    expect(durationOfPayload(asset('pic'), assets)).toBe(DEFAULT_IMAGE_DURATION);
    expect(durationOfPayload(asset('gone'), assets)).toBe(1);
    expect(ghostLabel(null)).toBe('');
    expect(ghostLabel({ kind: 'camera' })).toBe('camera');
    expect(ghostLabel({ kind: 'shape' })).toBe('rect');
    expect(ghostLabel({ kind: 'shape', preset: { name: 'box' } })).toBe('box');
    expect(ghostLabel(fx)).toBe(getEffect('shake')?.name ?? 'shake');
    expect(ghostLabel({ kind: 'effect', effect: 'nope' })).toBe('nope');
    expect(ghostLabel({ kind: 'text' })).toBe('');
    expect(ghostLabel({ kind: 'transition', transition: 'cross-fade' })).toBe('cross fade');
    expect(ghostLabel({ kind: 'transition', transition: 'nope' })).toBe('nope');
    expect(ghostLabel(asset('talk'))).toBe('');
  });

  it('range length', () => {
    expect(durationOfPayload(asset('talk', { range: { in: 1, out: 3 } }), assets)).toBe(2);
    expect(durationOfPayload(asset('talk', { range: { in: 4 } }), assets)).toBe(6);
    expect(durationOfPayload(asset('talk', { range: { in: 1, out: 1.01 } }), assets)).toBeCloseTo(0.05, 9);
  });

  it('part lanes', () => {
    expect(kindOfPayload(asset('talk', { parts: 'sound' }), assets)).toBe('audio');
    expect(kindOfPayload(asset('mute', { parts: 'sound' }), assets)).toBeNull();
    expect(kindOfPayload(asset('song', { parts: 'picture' }), assets)).toBeNull();
    expect(kindOfPayload(asset('talk', { parts: 'picture' }), assets)).toBe('video');
    expect(kindOfPayload(asset('talk', { parts: 'both' }), assets)).toBe('video');
  });

  it('part labels', () => {
    expect(ghostLabel(asset('talk', { parts: 'picture' }))).toBe('picture only');
    expect(ghostLabel(asset('talk', { parts: 'sound' }))).toBe('sound only');
    expect(ghostLabel(asset('talk', { parts: 'both' }))).toBe('');
  });

  it('takeOf', () => {
    expect(takeOf(asset('talk'))).toEqual({});
    expect(takeOf(asset('talk', { parts: 'sound' }))).toEqual({ parts: 'sound' });
    expect(takeOf(asset('talk', { range: { in: 1, out: 2 } }))).toEqual({ range: { in: 1, out: 2 } });
    expect(Object.keys(takeOf(asset('talk', { range: { in: 1 }, parts: 'picture' }))).sort()).toEqual(['parts', 'range']);
    expect(takeOf({ kind: 'text' })).toEqual({});
    expect(takeOf({ kind: 'camera' })).toEqual({});
    expect(takeOf({ kind: 'effect', effect: 'shake' })).toEqual({});
  });
});
