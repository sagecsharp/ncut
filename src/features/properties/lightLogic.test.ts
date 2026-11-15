import { describe, expect, it } from 'vitest';
import { createProject } from '../../lib/factory';
import type { Project, SceneLight } from '../../types';
import { autoKey, defaultLight, sameLight, setSunHeight, setSunPercent, setSunTurn } from './lightLogic';

const LIGHT: SceneLight = { sky: '#aabbcc', horizon: '#112233', ground: '#000000', sun: 0.4, sunColor: '#fff4e0', sunTurn: -35, sunHeight: 45 };
const plain = (background = '#336699'): Project => ({ ...createProject('lit'), background });

describe('lightLogic', () => {
  it('the default light takes the background as sky and horizon and has the default sun', () => {
    const l = defaultLight(plain(), 0);
    expect(l.sky).toBe('#336699');
    expect(l.horizon).toBe('#336699');
    expect(l.ground).toMatch(/^#[0-9a-f]{6}$/);
    expect(l.sun).toBe(0.4);
    expect(l.sunColor).toBe('#fff4e0');
    expect(l.sunTurn).toBe(-35);
    expect(l.sunHeight).toBe(45);
  });

  it('the sun share clamps and rounds', () => {
    expect(setSunPercent(LIGHT, -5).sun).toBe(0);
    expect(setSunPercent(LIGHT, 150).sun).toBe(1);
    expect(setSunPercent(LIGHT, NaN).sun).toBe(0);
    expect(setSunPercent(LIGHT, 33.33333).sun).toBe(0.3333);
  });

  it('the sun turn wraps into -180..180 in tenths', () => {
    expect(setSunTurn(LIGHT, 190).sunTurn).toBe(-170);
    expect(setSunTurn(LIGHT, -190).sunTurn).toBe(170);
    expect(setSunTurn(LIGHT, 180).sunTurn).toBe(180);
    expect(setSunTurn(LIGHT, -180).sunTurn).toBe(-180);
    expect(setSunTurn(LIGHT, -179.96).sunTurn).toBe(-180);
    expect(setSunTurn(LIGHT, 180.04).sunTurn).toBe(180);
    expect(setSunTurn(LIGHT, -180.4).sunTurn).toBe(179.6);
    expect(setSunTurn(LIGHT, 12.34).sunTurn).toBe(12.3);
    expect(setSunTurn(LIGHT, 725).sunTurn).toBe(5);
    expect(setSunTurn(LIGHT, NaN)).toBe(LIGHT);
    expect(setSunTurn(LIGHT, Infinity)).toBe(LIGHT);
  });

  it('the sun height clamps to 0..90 in tenths', () => {
    expect(setSunHeight(LIGHT, 120).sunHeight).toBe(90);
    expect(setSunHeight(LIGHT, -3).sunHeight).toBe(0);
    expect(setSunHeight(LIGHT, 33.36).sunHeight).toBe(33.4);
    expect(setSunHeight(LIGHT, NaN)).toBe(LIGHT);
  });

  it('two lights are the same when only the case of a color differs', () => {
    expect(sameLight(LIGHT, { ...LIGHT, sky: '#AABBCC', sunColor: '#FFF4E0' })).toBe(true);
    expect(sameLight(LIGHT, { ...LIGHT, sun: 0.5 })).toBe(false);
    expect(sameLight(LIGHT, { ...LIGHT, ground: '#000001' })).toBe(false);
    expect(sameLight(LIGHT, { ...LIGHT, sunTurn: 10 })).toBe(false);
  });

  it('the auto key changes when the background changes', () => {
    const a = autoKey(plain('#336699'), 0);
    expect(autoKey(plain('#336699'), 0)).toBe(a);
    expect(autoKey(plain('#cc3300'), 0)).not.toBe(a);
  });
});

describe('lightLogic at the end of the timeline', () => {
  it('copies the last frame when the playhead is at the end', async () => {
    const { createShapeClip, createTrack } = await import('../../lib/factory');
    const p = createProject('end');
    const top = createTrack('video', 'top');
    const bottom = createTrack('video', 'bottom');
    p.tracks = [top, bottom];
    p.background = '#000000';
    p.clips = [
      createShapeClip(bottom.id, 0, { duration: 10, width: p.width, height: p.height, color: '#e0e0e0' }),
      createShapeClip(top.id, 0, { threeD: true, duration: 10, lit: 0.75 }),
    ];
    expect(defaultLight(p, 10).sky).toBe('#e0e0e0');
    expect(defaultLight(p, 10)).toEqual(defaultLight(p, 10 - 1 / p.fps));
    expect(autoKey(p, 10)).toBe(autoKey(p, 10 - 1 / p.fps));
    expect(autoKey(p, 10)).not.toContain('#000000');
  });
});
