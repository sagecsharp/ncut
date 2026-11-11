import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Orbit } from './sceneCamera';
import {
  MIN_ORBIT_DISTANCE,
  SCENE_HINTS,
  SCENE_SCHEME_DEFAULT,
  VIEW_STEP_DEG,
  blenderCommand,
  blenderPress,
  blenderView,
  boundingSphere,
  clampOrbitDistance,
  dollyDistance,
  parseScheme,
  pointInRect,
  quadTouchesRect,
  rectOf,
  typeNumber,
  typedValue,
  useSceneControls,
} from './sceneControls';

const press = (button: number, mods: Partial<{ shift: boolean; ctrl: boolean; alt: boolean }> = {}) => ({ button, shift: false, ctrl: false, alt: false, ...mods });
const keyOf = (key: string, mods: Partial<{ code: string; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }> = {}) => ({
  key,
  code: '',
  shift: false,
  ctrl: false,
  alt: false,
  meta: false,
  ...mods,
});
const pad = (code: string, mods: Partial<{ shift: boolean; ctrl: boolean; alt: boolean; meta: boolean }> = {}) => keyOf('', { code, ...mods });

describe('which controls the scene view uses', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
    useSceneControls.setState({ scheme: SCENE_SCHEME_DEFAULT });
  });
  it('is blender unless unity was picked', () => {
    expect(SCENE_SCHEME_DEFAULT).toBe('blender');
    expect(parseScheme('unity')).toBe('unity');
    for (const raw of [null, undefined, '', 'blender', 'Unity', 'UNITY', ' unity', 1, true, {}, ['unity']]) expect(parseScheme(raw)).toBe('blender');
  });
  it('has a help line for both, and they differ', () => {
    expect(SCENE_HINTS.blender).toContain('g r s');
    expect(SCENE_HINTS.blender).toContain('middle drag');
    expect(SCENE_HINTS.blender).toContain('stretch');
    expect(SCENE_HINTS.unity).toContain('w e r');
    expect(SCENE_HINTS.unity).not.toContain('g r s');
  });
  it('switches and switches back', () => {
    useSceneControls.getState().setScheme('unity');
    expect(useSceneControls.getState().scheme).toBe('unity');
    useSceneControls.getState().setScheme('blender');
    expect(useSceneControls.getState().scheme).toBe('blender');
    // anything that is not a scheme is the default
    useSceneControls.getState().setScheme('maya' as never);
    expect(useSceneControls.getState().scheme).toBe('blender');
  });
  it('starts with what the browser kept, and keeps what is picked', async () => {
    const kept = new Map<string, string>([['ncut.scene.controls', 'unity']]);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => kept.get(k) ?? null,
      setItem: (k: string, v: string) => void kept.set(k, v),
    });
    vi.resetModules();
    const fresh = await import('./sceneControls');
    expect(fresh.useSceneControls.getState().scheme).toBe('unity');
    fresh.useSceneControls.getState().setScheme('blender');
    expect(kept.get('ncut.scene.controls')).toBe('blender');
    // the same choice again writes nothing
    kept.delete('ncut.scene.controls');
    fresh.useSceneControls.getState().setScheme('blender');
    expect(kept.has('ncut.scene.controls')).toBe(false);
  });
  it('starts with blender when nothing or rubbish is stored or storage throws, and survives a failing write', async () => {
    vi.stubGlobal('localStorage', {
      getItem: () => 'maya',
      setItem: () => {
        throw new Error('full');
      },
    });
    vi.resetModules();
    const broken = await import('./sceneControls');
    expect(broken.useSceneControls.getState().scheme).toBe('blender');
    expect(() => broken.useSceneControls.getState().setScheme('unity')).not.toThrow();
    expect(broken.useSceneControls.getState().scheme).toBe('unity');
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    vi.resetModules();
    const blocked = await import('./sceneControls');
    expect(blocked.useSceneControls.getState().scheme).toBe('blender');
  });
});

describe('what a press does with the blender controls', () => {
  it('the middle button turns the view, shift pans, ctrl zooms', () => {
    expect(blenderPress(press(1), false)).toBe('orbit');
    expect(blenderPress(press(1, { shift: true }), false)).toBe('pan');
    expect(blenderPress(press(1, { ctrl: true }), false)).toBe('dolly');
    // ctrl wins over shift, like blender's ctrl + shift + middle
    expect(blenderPress(press(1, { ctrl: true, shift: true }), false)).toBe('dolly');
  });
  it('alt + left stands in for the middle button', () => {
    expect(blenderPress(press(0, { alt: true }), false)).toBe('orbit');
    expect(blenderPress(press(0, { alt: true, shift: true }), false)).toBe('pan');
    expect(blenderPress(press(0, { alt: true, ctrl: true }), false)).toBe('dolly');
  });
  it('the left button works on the scene, with or without shift and ctrl', () => {
    expect(blenderPress(press(0), false)).toBe('primary');
    expect(blenderPress(press(0, { shift: true }), false)).toBe('primary');
    expect(blenderPress(press(0, { ctrl: true }), false)).toBe('primary');
  });
  it('the right button and the side buttons do nothing', () => {
    for (const b of [2, 3, 4]) expect(blenderPress(press(b), false)).toBe('none');
    expect(blenderPress(press(2, { alt: true }), false)).toBe('none');
  });
  it('while something is moved, left keeps it and right takes it back, whatever is held', () => {
    for (const mods of [{}, { shift: true }, { ctrl: true }, { alt: true }]) {
      expect(blenderPress(press(0, mods), true)).toBe('confirm');
      expect(blenderPress(press(2, mods), true)).toBe('cancel');
      expect(blenderPress(press(1, mods), true)).toBe('none');
    }
  });
});

describe('zooming with ctrl + middle drag', () => {
  it('up moves in, down moves out, no movement changes nothing', () => {
    expect(dollyDistance(1000, 0)).toBe(1000);
    expect(dollyDistance(1000, -100)).toBeLessThan(1000);
    expect(dollyDistance(1000, 100)).toBeGreaterThan(1000);
    // the same way back is the same distance
    expect(dollyDistance(dollyDistance(1000, 150), -150)).toBeCloseTo(1000, 6);
  });
  it('never runs away', () => {
    expect(Number.isFinite(dollyDistance(1000, 1e9))).toBe(true);
    expect(dollyDistance(1000, -1e9)).toBeGreaterThan(0);
  });
  it('stays inside what the wheel allows', () => {
    expect(clampOrbitDistance(5, 1000)).toBe(MIN_ORBIT_DISTANCE);
    expect(clampOrbitDistance(-50, 1000)).toBe(MIN_ORBIT_DISTANCE);
    expect(clampOrbitDistance(500, 1000)).toBe(500);
    expect(clampOrbitDistance(1e9, 1000)).toBe(60000);
    expect(clampOrbitDistance(Number.NaN, 1000)).toBe(1000);
    expect(clampOrbitDistance(Number.POSITIVE_INFINITY, 1000)).toBe(1000);
    // a broken home distance still gives a usable number
    expect(clampOrbitDistance(100, 0)).toBe(MIN_ORBIT_DISTANCE);
  });
});

describe('the keys of the blender controls', () => {
  it('g r s grab, rotate and scale', () => {
    expect(blenderCommand(keyOf('g'))).toEqual({ kind: 'grab' });
    expect(blenderCommand(keyOf('r'))).toEqual({ kind: 'rotate' });
    expect(blenderCommand(keyOf('s'))).toEqual({ kind: 'scale' });
    // caps lock makes no difference
    expect(blenderCommand(keyOf('G'))).toEqual({ kind: 'grab' });
  });
  it('alt + g r s put position, rotation and scale back', () => {
    expect(blenderCommand(keyOf('g', { alt: true }))).toEqual({ kind: 'clear-move' });
    expect(blenderCommand(keyOf('r', { alt: true }))).toEqual({ kind: 'clear-rotate' });
    expect(blenderCommand(keyOf('s', { alt: true }))).toEqual({ kind: 'clear-scale' });
  });
  it('shift + d copies, x deletes, a selects all, alt + a nothing, f frames', () => {
    expect(blenderCommand(keyOf('D', { shift: true }))).toEqual({ kind: 'duplicate' });
    expect(blenderCommand(keyOf('d'))).toBeNull();
    expect(blenderCommand(keyOf('x'))).toEqual({ kind: 'delete' });
    expect(blenderCommand(keyOf('a'))).toEqual({ kind: 'select-all' });
    expect(blenderCommand(keyOf('a', { alt: true }))).toEqual({ kind: 'select-none' });
    expect(blenderCommand(keyOf('f'))).toEqual({ kind: 'frame' });
    expect(blenderCommand(keyOf('Home'))).toEqual({ kind: 'frame-all' });
  });
  it('leaves the editor its own shortcuts', () => {
    // ctrl + z / c / v / x / s / a / d / g, cmd anything, shift + letters that mean something else, plain other keys
    for (const k of ['z', 'c', 'v', 'x', 's', 'a', 'd', 'g', 'r', 'f']) {
      expect(blenderCommand(keyOf(k, { ctrl: true }))).toBeNull();
      expect(blenderCommand(keyOf(k, { meta: true }))).toBeNull();
    }
    for (const k of ['G', 'R', 'S', 'X', 'A', 'F']) expect(blenderCommand(keyOf(k, { shift: true }))).toBeNull();
    for (const k of [' ', 'Delete', 'Backspace', 'Escape', 'Enter', 'ArrowLeft', 'w', 'e', 'q', 'm', 'c', 'v', '3', '1', 'Tab', 'F5']) expect(blenderCommand(keyOf(k))).toBeNull();
    expect(blenderCommand(keyOf('d', { shift: true, alt: true }))).toBeNull();
    expect(blenderCommand(keyOf('Home', { ctrl: true }))).toBeNull();
  });
  it('the numpad picks the view, by position (num lock on or off)', () => {
    expect(blenderCommand(pad('Numpad1'))).toEqual({ kind: 'view', code: 'Numpad1', ctrl: false });
    expect(blenderCommand(pad('Numpad1', { ctrl: true }))).toEqual({ kind: 'view', code: 'Numpad1', ctrl: true });
    expect(blenderCommand(pad('Numpad3'))).toEqual({ kind: 'view', code: 'Numpad3', ctrl: false });
    expect(blenderCommand(pad('Numpad7', { ctrl: true }))).toEqual({ kind: 'view', code: 'Numpad7', ctrl: true });
    for (const code of ['Numpad9', 'Numpad4', 'Numpad6', 'Numpad8', 'Numpad2', 'NumpadAdd', 'NumpadSubtract']) {
      expect(blenderCommand(pad(code))).toEqual({ kind: 'view', code, ctrl: false });
      expect(blenderCommand(pad(code, { ctrl: true }))).toBeNull();
    }
    // num lock off: the key reads "End" but the position is still numpad 1
    expect(blenderCommand(keyOf('End', { code: 'Numpad1' }))).toEqual({ kind: 'view', code: 'Numpad1', ctrl: false });
    // the digit row is not the numpad
    expect(blenderCommand(keyOf('1', { code: 'Digit1' }))).toBeNull();
  });
  it('numpad 0 looks through the camera, ctrl + alt + numpad 0 puts the camera where the view is, numpad . frames', () => {
    expect(blenderCommand(pad('Numpad0'))).toEqual({ kind: 'camera-view' });
    expect(blenderCommand(pad('Numpad0', { ctrl: true, alt: true }))).toEqual({ kind: 'camera-to-view' });
    expect(blenderCommand(pad('Numpad0', { ctrl: true }))).toBeNull();
    expect(blenderCommand(pad('Numpad0', { alt: true }))).toBeNull();
    expect(blenderCommand(pad('Numpad0', { shift: true }))).toBeNull();
    expect(blenderCommand(pad('NumpadDecimal'))).toEqual({ kind: 'frame' });
    expect(blenderCommand(pad('Numpad1', { meta: true }))).toBeNull();
    expect(blenderCommand(pad('Numpad5'))).toBeNull();
  });
});

describe('the view a numpad key gives', () => {
  const o: Orbit = { targetX: 100, targetY: 200, targetZ: 300, yaw: 30, pitch: -20, distance: 1500 };
  it('1 front, 3 right, 7 top, with ctrl the other side', () => {
    expect(blenderView('Numpad1', false, o)).toMatchObject({ yaw: 0, pitch: 0 });
    expect(blenderView('Numpad1', true, o)).toMatchObject({ yaw: 180, pitch: 0 });
    expect(blenderView('Numpad3', false, o)).toMatchObject({ yaw: -90, pitch: 0 });
    expect(blenderView('Numpad3', true, o)).toMatchObject({ yaw: 90, pitch: 0 });
    // pitch + looks up: the top view looks down from above, so its pitch is negative... the camera sits above
    expect(blenderView('Numpad7', false, o)).toMatchObject({ yaw: 0, pitch: -89 });
    expect(blenderView('Numpad7', true, o)).toMatchObject({ yaw: 0, pitch: 89 });
  });
  it('keeps the point it turns around and the distance', () => {
    for (const code of ['Numpad1', 'Numpad3', 'Numpad7', 'Numpad9', 'Numpad4', 'Numpad6', 'Numpad8', 'Numpad2']) {
      expect(blenderView(code, false, o)).toMatchObject({ targetX: 100, targetY: 200, targetZ: 300, distance: 1500 });
    }
  });
  it('9 looks from the opposite side, twice is where it started', () => {
    const once = blenderView('Numpad9', false, o)!;
    expect(once).toMatchObject({ yaw: -150, pitch: 20 });
    const twice = blenderView('Numpad9', false, once)!;
    expect(twice.yaw).toBeCloseTo(30, 9);
    expect(twice.pitch).toBeCloseTo(-20, 9);
  });
  it('4 and 6 turn in steps and undo each other, also across the back', () => {
    const left = blenderView('Numpad4', false, o)!;
    expect(left.yaw).toBe(30 + VIEW_STEP_DEG);
    expect(blenderView('Numpad6', false, left)!.yaw).toBe(30);
    expect(blenderView('Numpad4', false, { ...o, yaw: 175 })!.yaw).toBe(-170);
    expect(blenderView('Numpad6', false, { ...o, yaw: -175 })!.yaw).toBe(170);
  });
  it('8 and 2 tilt in steps and stop before straight up or down', () => {
    expect(blenderView('Numpad8', false, o)!.pitch).toBe(-20 - VIEW_STEP_DEG);
    expect(blenderView('Numpad2', false, o)!.pitch).toBe(-20 + VIEW_STEP_DEG);
    expect(blenderView('Numpad8', false, { ...o, pitch: -85 })!.pitch).toBe(-89);
    expect(blenderView('Numpad2', false, { ...o, pitch: 85 })!.pitch).toBe(89);
  });
  it('+ moves in, - moves out, and they undo each other', () => {
    const near = blenderView('NumpadAdd', false, o)!;
    expect(near.distance).toBeLessThan(1500);
    expect(near).toMatchObject({ yaw: 30, pitch: -20 });
    expect(blenderView('NumpadSubtract', false, near)!.distance).toBeCloseTo(1500, 9);
  });
  it('is nothing for any other key, and never changes what it was given', () => {
    const before = { ...o };
    for (const code of ['Numpad5', 'Numpad0', 'KeyG', '', 'Digit1']) expect(blenderView(code, false, o)).toBeNull();
    blenderView('Numpad1', true, o);
    expect(o).toEqual(before);
  });
});

describe('a number typed while something is moved', () => {
  const type = (keys: string) => {
    let text = '';
    for (const k of keys.split(' ')) text = typeNumber(text, k) ?? text;
    return text;
  };
  it('takes digits and one decimal point', () => {
    expect(type('1 0 0')).toBe('100');
    expect(type('1 . 5')).toBe('1.5');
    expect(type('1 . 5 . 2')).toBe('1.52');
    expect(type('. 5')).toBe('.5');
    // the comma of a numpad on a european layout
    expect(type('2 , 5')).toBe('2.5');
  });
  it('minus flips the sign wherever it is typed', () => {
    expect(type('- 4 5')).toBe('-45');
    expect(type('4 5 -')).toBe('-45');
    expect(type('4 5 - -')).toBe('45');
    expect(type('-')).toBe('-');
  });
  it('backspace takes the last character away, on an empty text too', () => {
    expect(type('1 2 Backspace')).toBe('1');
    expect(typeNumber('', 'Backspace')).toBe('');
    expect(type('- 1 Backspace Backspace')).toBe('');
  });
  it('is not a number key for anything else', () => {
    for (const k of ['x', 'g', 'Enter', 'Escape', ' ', 'e', '+', 'Shift', 'ArrowUp', 'F1', '10']) expect(typeNumber('12', k)).toBeNull();
  });
  it('stops at nine digits', () => {
    expect(type('1 2 3 4 5 6 7 8 9 0 1')).toBe('123456789');
    expect(type('- 1 2 3 4 5 . 6 7 8 9 0')).toBe('-12345.6789');
  });
  it('reads as a number once there is a digit', () => {
    expect(typedValue('')).toBeNull();
    expect(typedValue('-')).toBeNull();
    expect(typedValue('.')).toBeNull();
    expect(typedValue('-.')).toBeNull();
    expect(typedValue('45')).toBe(45);
    expect(typedValue('-45')).toBe(-45);
    expect(typedValue('.5')).toBe(0.5);
    expect(typedValue('-.5')).toBe(-0.5);
    expect(typedValue('3.')).toBe(3);
    expect(typedValue('0')).toBe(0);
    expect(typedValue('1e5x')).toBeNull();
  });
  it('whatever is typed with the number keys always reads as a finite number or nothing', () => {
    const keys = ['0', '1', '9', '.', '-', 'Backspace', ','];
    let text = '';
    let seed = 7;
    for (let i = 0; i < 4000; i++) {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      text = typeNumber(text, keys[seed % keys.length]!) ?? text;
      const v = typedValue(text);
      expect(v === null || Number.isFinite(v)).toBe(true);
      expect(text.length).toBeLessThanOrEqual(11);
    }
  });
});

describe('the selection box', () => {
  it('is the same box whichever corner the drag started at', () => {
    expect(rectOf(10, 20, 30, 5)).toEqual({ x0: 10, y0: 5, x1: 30, y1: 20 });
    expect(rectOf(30, 5, 10, 20)).toEqual({ x0: 10, y0: 5, x1: 30, y1: 20 });
  });
  it('holds the points inside it and on its edge', () => {
    const r = rectOf(0, 0, 10, 10);
    expect(pointInRect(5, 5, r)).toBe(true);
    expect(pointInRect(0, 10, r)).toBe(true);
    expect(pointInRect(-0.1, 5, r)).toBe(false);
    expect(pointInRect(5, 10.1, r)).toBe(false);
  });
  const quad = [100, 100, 300, 100, 300, 200, 100, 200];
  it('picks a plane with a corner in the box', () => {
    expect(quadTouchesRect(quad, rectOf(50, 50, 120, 120))).toBe(true);
  });
  it('picks a big plane when the box is drawn inside it', () => {
    expect(quadTouchesRect(quad, rectOf(150, 120, 160, 130))).toBe(true);
  });
  it('picks a plane the box cuts across without holding a corner of it', () => {
    // a tall thin box through the middle
    expect(quadTouchesRect(quad, rectOf(190, 50, 210, 250))).toBe(true);
    // a plane seen almost edge on
    expect(quadTouchesRect([0, 100, 400, 101, 400, 102, 0, 101], rectOf(190, 50, 210, 250))).toBe(true);
  });
  it('leaves a plane next to the box alone', () => {
    expect(quadTouchesRect(quad, rectOf(0, 0, 90, 90))).toBe(false);
    expect(quadTouchesRect(quad, rectOf(310, 100, 400, 200))).toBe(false);
    expect(quadTouchesRect(quad, rectOf(100, 210, 300, 300))).toBe(false);
  });
  it('handles a turned plane by its real outline, not its bounding box', () => {
    const diamond = [200, 100, 300, 200, 200, 300, 100, 200];
    // the corner of the bounding box is outside the diamond
    expect(quadTouchesRect(diamond, rectOf(100, 100, 120, 120))).toBe(false);
    expect(quadTouchesRect(diamond, rectOf(100, 100, 160, 160))).toBe(true);
  });
  it('never picks a plane with broken corners', () => {
    expect(quadTouchesRect([Number.NaN, 0, 1, 1, 2, 2, 3, 3], rectOf(-10, -10, 10, 10))).toBe(false);
    expect(quadTouchesRect([0, 0, Number.POSITIVE_INFINITY, 1, 2, 2, 3, 3], rectOf(-10, -10, 10, 10))).toBe(false);
    expect(quadTouchesRect([0, 0, 1, 1], rectOf(-10, -10, 10, 10))).toBe(false);
  });
});

describe('everything in view', () => {
  it('is nothing without anything', () => {
    expect(boundingSphere([])).toBeNull();
  });
  it('is the thing itself when there is one', () => {
    expect(boundingSphere([{ center: [1, 2, 3], radius: 50 }])).toEqual({ center: [1, 2, 3], radius: 50 });
  });
  it('holds every sphere it was made from', () => {
    const items = [
      { center: [0, 0, 0] as [number, number, number], radius: 100 },
      { center: [1000, 0, 0] as [number, number, number], radius: 10 },
      { center: [0, -400, 2000] as [number, number, number], radius: 300 },
    ];
    const all = boundingSphere(items)!;
    for (const it of items) {
      const d = Math.hypot(it.center[0] - all.center[0], it.center[1] - all.center[1], it.center[2] - all.center[2]);
      expect(d + it.radius).toBeLessThanOrEqual(all.radius + 1e-9);
    }
  });
  it('treats a negative radius as a point', () => {
    expect(boundingSphere([{ center: [5, 5, 5], radius: -20 }])).toEqual({ center: [5, 5, 5], radius: 0 });
  });
});
