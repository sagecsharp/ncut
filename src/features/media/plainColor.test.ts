import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_IMAGE_DURATION, createShapeClip } from '../../lib/factory';
import { SHAPE_KINDS } from '../../types';
import { PLAIN_COLOR_DEFAULT, PLAIN_COLOR_NAME, parsePlainColor, plainColorPreset, showsPlainColor, usePlainColor } from './plainColor';

describe('the color of the plain color card', () => {
  it('keeps a six digit hex color, in lowercase', () => {
    expect(parsePlainColor('#12ab9f')).toBe('#12ab9f');
    expect(parsePlainColor('#12AB9F')).toBe('#12ab9f');
    expect(parsePlainColor('  #000000 ')).toBe('#000000');
  });
  it('spells out the short form', () => {
    expect(parsePlainColor('#f0a')).toBe('#ff00aa');
    expect(parsePlainColor('#FFF')).toBe('#ffffff');
  });
  it('falls back to white for anything else', () => {
    for (const bad of [null, undefined, '', 'red', '#12345', '#1234567', '#12345678', 'rgb(1,2,3)', '#gggggg', 42, {}, [], '#fff;background:url(x)']) {
      expect(parsePlainColor(bad)).toBe(PLAIN_COLOR_DEFAULT);
    }
  });
});

describe('the clip the plain color card makes', () => {
  it('is a flat rect of the project size, named plain color, as long as a still image', () => {
    const p = plainColorPreset(1920, 1080, '#336699');
    expect(p).toEqual({ name: PLAIN_COLOR_NAME, kind: 'rect', width: 1920, height: 1080, color: '#336699', duration: DEFAULT_IMAGE_DURATION });
    expect(SHAPE_KINDS).toContain(p.kind);
  });
  it('has no gradient, outline, corner radius or 3d of its own', () => {
    const p = plainColorPreset(1080, 1920, '#000000');
    for (const key of ['color2', 'stroke', 'radius', 'threeD', 'filled', 'transform'] as const) expect(key in p).toBe(false);
  });
  it('rounds the size and never makes an empty or broken box', () => {
    expect(plainColorPreset(1280.4, 719.6, '#fff')).toMatchObject({ width: 1280, height: 720, color: '#ffffff' });
    expect(plainColorPreset(0, -5, '#fff')).toMatchObject({ width: 1920, height: 1080 });
    expect(plainColorPreset(Number.NaN, Number.POSITIVE_INFINITY, '#fff')).toMatchObject({ width: 1920, height: 1080 });
  });
  it('never passes a broken color on', () => {
    expect(plainColorPreset(100, 100, 'nope').color).toBe(PLAIN_COLOR_DEFAULT);
  });
  it('makes a whole shape clip when it goes through the factory', () => {
    const clip = createShapeClip('trk', 2, plainColorPreset(1920, 1080, '#ff0000'));
    expect(clip).toMatchObject({ type: 'shape', kind: 'rect', name: PLAIN_COLOR_NAME, width: 1920, height: 1080, color: '#ff0000', duration: DEFAULT_IMAGE_DURATION, start: 2, trackId: 'trk' });
    expect(clip.transform).toBeDefined();
  });
});

describe('when the plain color card is listed', () => {
  const base = { kind: 'all' as const, query: '', unusedOnly: false };
  it('is there by default', () => {
    expect(showsPlainColor(base)).toBe(true);
  });
  it('counts as an image', () => {
    expect(showsPlainColor({ ...base, kind: 'image' })).toBe(true);
    expect(showsPlainColor({ ...base, kind: 'video' })).toBe(false);
    expect(showsPlainColor({ ...base, kind: 'audio' })).toBe(false);
  });
  it('is found by its name', () => {
    expect(showsPlainColor({ ...base, query: 'plain' })).toBe(true);
    expect(showsPlainColor({ ...base, query: '  COLOR ' })).toBe(true);
    expect(showsPlainColor({ ...base, query: 'n c' })).toBe(true);
    expect(showsPlainColor({ ...base, query: 'holiday' })).toBe(false);
  });
  it('is not an unused file', () => {
    expect(showsPlainColor({ ...base, unusedOnly: true })).toBe(false);
  });
});

describe('the remembered color', () => {
  beforeEach(() => {
    usePlainColor.setState({ color: PLAIN_COLOR_DEFAULT });
  });
  it('starts white and takes a new color', () => {
    expect(usePlainColor.getState().color).toBe(PLAIN_COLOR_DEFAULT);
    usePlainColor.getState().setColor('#102030');
    expect(usePlainColor.getState().color).toBe('#102030');
  });
  it('cleans what it is given', () => {
    usePlainColor.getState().setColor('#ABC');
    expect(usePlainColor.getState().color).toBe('#aabbcc');
    usePlainColor.getState().setColor('garbage');
    expect(usePlainColor.getState().color).toBe(PLAIN_COLOR_DEFAULT);
  });
});
