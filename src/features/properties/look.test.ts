import { describe, expect, it } from 'vitest';
import type { TextClip, VisualClip } from '../../types';
import { cropPercent, maxCropPercent, setCropEdge } from './look';
import { captureLook, lookPatch } from './lookClipboard';

describe('crop edges', () => {
  it('creates a crop from the first value', () => {
    expect(setCropEdge(null, 'left', 10)).toEqual({ left: 0.1, top: 0, right: 0, bottom: 0 });
    expect(setCropEdge(undefined, 'bottom', 25)).toEqual({ left: 0, top: 0, right: 0, bottom: 0.25 });
  });
  it('returns null when every edge is 0', () => {
    expect(setCropEdge({ left: 0.1, top: 0, right: 0, bottom: 0 }, 'left', 0)).toBeNull();
  });
  it('caps one edge at 95 and a pair at 99', () => {
    expect(setCropEdge(null, 'top', 200)?.top).toBe(0.95);
    const c = { left: 0, top: 0, right: 0.6, bottom: 0 };
    expect(setCropEdge(c, 'left', 90)?.left).toBe(0.39);
    expect(maxCropPercent(c, 'left')).toBe(39);
    expect(maxCropPercent(null, 'right')).toBe(95);
  });
  it('ignores junk', () => {
    expect(setCropEdge(null, 'left', Number.NaN)).toBeNull();
    expect(setCropEdge(null, 'left', -5)).toBeNull();
  });
  it('shows percents', () => {
    expect(cropPercent({ left: 0.125, top: 0, right: 0, bottom: 0 }, 'left')).toBe(12.5);
    expect(cropPercent(null, 'top')).toBe(0);
  });
});

const base = {
  id: 'a',
  trackId: 't',
  start: 0,
  duration: 1,
  name: 'a',
  fadeIn: 0,
  fadeOut: 0,
  transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5 },
};

describe('look clipboard', () => {
  const text: TextClip = {
    ...base,
    type: 'text',
    text: 'hi',
    fontFamily: 'x',
    fontSize: 40,
    fontWeight: 700,
    italic: false,
    color: '#ff0000',
    background: null,
    align: 'center',
    blend: 'add',
    curve: 30,
    motionIn: { id: 'fade', duration: 0.5 },
  };
  const image: VisualClip = { ...base, type: 'image', assetId: 'x', blend: 'screen', radius: 0.2, crop: { left: 0.1, top: 0, right: 0, bottom: 0 } };

  it('copies the common look and opacity', () => {
    const look = captureLook(image);
    expect(look.opacity).toBe(0.5);
    expect(look.values.blend).toBe('screen');
    expect(look.values.radius).toBe(0.2);
    expect(look.values.transition).toBeNull();
    expect('curve' in look.values).toBe(false);
  });
  it('does not alias the source clip', () => {
    const look = captureLook(image);
    expect(look.values.crop).not.toBe(image.crop);
  });
  it('applies text style only text to text', () => {
    const look = captureLook(text);
    expect(lookPatch(look, 'text').curve).toBe(30);
    expect(lookPatch(look, 'text').color).toBe('#ff0000');
    expect('curve' in lookPatch(look, 'image')).toBe(false);
    expect(lookPatch(look, 'image').blend).toBe('add');
  });
  it('clears fields the source did not have', () => {
    const patch = lookPatch(captureLook(image), 'image');
    expect(patch.motionIn).toBeNull();
  });
  it('carries color, green screen and motion blur but not the parent', () => {
    const rich: VisualClip = {
      ...image,
      parent: 'p',
      adjust: { brightness: 0.2, contrast: 0, saturation: 0, hue: 0, temperature: 0 },
      chromaKey: { color: '#00d000', tolerance: 0.3, softness: 0.1, spill: 0.5 },
      motionBlur: { shutter: 0.5, samples: 8 },
    };
    const look = captureLook(rich);
    expect(look.values.adjust).toEqual(rich.adjust);
    expect(look.values.adjust).not.toBe(rich.adjust);
    expect(look.values.chromaKey).toEqual(rich.chromaKey);
    expect(look.values.motionBlur).toEqual(rich.motionBlur);
    expect('parent' in look.values).toBe(false);
    expect(lookPatch(look, 'video').chromaKey).toEqual(rich.chromaKey);
    // no green screen on text and shapes, other fields still apply
    const toText = lookPatch(look, 'text');
    expect('chromaKey' in toText).toBe(false);
    expect(toText.adjust).toEqual(rich.adjust);
    expect('chromaKey' in lookPatch(look, 'shape')).toBe(false);
  });
  it('clears color fields the source did not have', () => {
    const patch = lookPatch(captureLook(image), 'image');
    expect(patch.adjust).toBeNull();
    expect(patch.chromaKey).toBeNull();
    expect(patch.motionBlur).toBeNull();
  });
  it('keeps crop and radius off text targets', () => {
    const patch = lookPatch(captureLook(image), 'text');
    expect('crop' in patch).toBe(false);
    expect('radius' in patch).toBe(false);
  });
  it('carries the mask but not the look target', () => {
    const masked: VisualClip = {
      ...image,
      lookTarget: 'x',
      mask: { shape: 'star', x: 0.1, y: 0, width: 0.5, height: 0.5, rotation: 10, feather: 0.1, invert: true },
    };
    const look = captureLook(masked);
    expect(look.values.mask).toEqual(masked.mask);
    expect(look.values.mask).not.toBe(masked.mask);
    expect('lookTarget' in look.values).toBe(false);
    expect(lookPatch(look, 'text').mask).toEqual(masked.mask);
    expect(lookPatch(look, 'video').mask).toEqual(masked.mask);
  });
  it('clears the mask when the source had none', () => {
    expect(lookPatch(captureLook(image), 'image').mask).toBeNull();
  });
});
