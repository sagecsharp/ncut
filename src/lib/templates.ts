/**
 * starter projects: ready-made timelines built only from text, shapes, cameras and effects (no
 * media), so a new project can open with something to look at and take apart.
 * every template fits any canvas size: sizes are in units of the shorter canvas side.
 * pure: no dom, no storage.
 */
import type { CameraClip, Clip, EffectClip, Keyframes, Project, ShapeClip, TextClip, Track } from '../types';
import { createCameraClip, createEffectClip, createShapeClip, createTextClip, createTrack } from './factory';

export interface ProjectTemplate {
  id: string;
  /** lowercase label for the menu */
  name: string;
  description: string;
  /** fills an empty project (keeps its id, name, size and frame rate) */
  build(project: Project): Project;
}

/** collects tracks from the top layer down, one clip row each */
class Builder {
  readonly tracks: Track[] = [];
  readonly clips: Clip[] = [];
  /** shorter canvas side / 1080: multiply design pixels by this */
  readonly u: number;
  readonly w: number;
  readonly h: number;

  constructor(project: Project) {
    this.w = project.width;
    this.h = project.height;
    this.u = Math.min(project.width, project.height) / 1080;
  }

  /** a new track under the ones added so far. returns its id. */
  track(name: string): string {
    const t = createTrack('video', name);
    this.tracks.push(t);
    return t.id;
  }

  text(trackId: string, start: number, over: Partial<TextClip>): TextClip {
    const c = createTextClip(trackId, start, over);
    this.clips.push(c);
    return c;
  }

  shape(trackId: string, start: number, over: Partial<ShapeClip>): ShapeClip {
    const c = createShapeClip(trackId, start, over);
    this.clips.push(c);
    return c;
  }

  camera(trackId: string, start: number, over: Partial<CameraClip>): CameraClip {
    const c = createCameraClip(trackId, start, over);
    this.clips.push(c);
    return c;
  }

  effect(trackId: string, effect: string, start: number, over: Partial<EffectClip>): EffectClip {
    // a fixed seed keeps a template the same every time it is made
    const c = createEffectClip(effect, effect.replace(/-/g, ' '), trackId, start, { seed: 7, ...over });
    this.clips.push(c);
    return c;
  }

  finish(project: Project, background: string): Project {
    const audio = project.tracks.filter((t) => t.kind === 'audio');
    return { ...project, background, tracks: [...this.tracks, ...audio], clips: this.clips };
  }
}

/** two keys: from at the clip's start, to at `end` seconds */
function ramp(from: number, to: number, end: number, ease: 'linear' | 'ease' | 'ease-out' | 'ease-in' = 'ease'): Keyframes[string] {
  return [
    { t: 0, v: from, ease },
    { t: end, v: to, ease },
  ];
}

const INK = '#f2f2f2';
const DIM = '#8a8f98';
const ACCENT = '#ffe14d';

function titleInSpace(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 6;

  b.effect(b.track('motion blur'), 'motion-blur', 0, { duration: len, params: { shutter: 180, samples: 10 } });
  b.camera(b.track('camera'), 0, {
    duration: len,
    keyframes: {
      z: ramp(-1500 * u, -120 * u, len, 'ease-out'),
      x: ramp(-520 * u, 140 * u, len, 'ease-out'),
      pan: ramp(-22, 6, len, 'ease-out'),
      tilt: ramp(7, 0, len, 'ease-out'),
    },
  });
  b.text(b.track('title'), 0, {
    duration: len,
    name: 'title',
    text: 'your title',
    fontSize: 190 * u,
    color: INK,
    threeD: true,
    letterSpacing: 0.04,
    animIn: { id: 'cascade', duration: 1.2 },
    fadeOut: 0.5,
    transform: { x: 0, y: -40 * u, scale: 1, rotation: 0, opacity: 1, z: 0 },
  });
  b.text(b.track('line under it'), 0.9, {
    duration: len - 0.9,
    name: 'subtitle',
    text: 'a line under it',
    fontSize: 54 * u,
    fontWeight: 400,
    color: DIM,
    threeD: true,
    letterSpacing: 0.3,
    fadeIn: 0.6,
    fadeOut: 0.5,
    transform: { x: 0, y: 130 * u, scale: 1, rotation: 0, opacity: 1, z: -120 * u },
  });
  // things floating at different depths, so the camera move reads as depth
  const props: { kind: ShapeClip['kind']; x: number; y: number; z: number; size: number; turn: number; loop: string }[] = [
    { kind: 'ellipse', x: -620, y: -260, z: 900, size: 520, turn: 25, loop: 'float' },
    { kind: 'rect', x: 700, y: 240, z: 600, size: 360, turn: -35, loop: 'rotate' },
    { kind: 'triangle', x: -760, y: 330, z: 300, size: 240, turn: 15, loop: 'wobble' },
    { kind: 'polygon', x: 560, y: -360, z: 1300, size: 420, turn: -10, loop: 'rotate' },
    { kind: 'star', x: 60, y: -470, z: 1700, size: 200, turn: 0, loop: 'pulse' },
  ];
  for (const p of props) {
    b.shape(b.track(p.kind), 0, {
      duration: len,
      name: p.kind,
      kind: p.kind,
      width: p.size * u,
      height: p.size * u,
      filled: false,
      color: DIM,
      stroke: { color: DIM, width: 6 * u },
      threeD: true,
      fadeIn: 0.4,
      fadeOut: 0.5,
      motionLoop: { id: p.loop, duration: p.loop === 'rotate' ? 14 : 4 },
      transform: { x: p.x * u, y: p.y * u, scale: 1, rotation: 0, opacity: 0.8, z: p.z * u, rotY: p.turn },
    });
  }
  return b.finish(project, '#0b0c0e');
}

function solids(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 8;

  b.camera(b.track('camera'), 0, {
    duration: len,
    tilt: -12,
    y: -260 * u,
    keyframes: {
      x: ramp(-1100 * u, 1100 * u, len, 'linear'),
      pan: ramp(38, -38, len, 'linear'),
      z: ramp(-500 * u, -500 * u, len, 'linear'),
    },
  });
  b.text(b.track('label'), 0, {
    duration: len,
    name: 'label',
    text: 'box  ball  can',
    fontSize: 64 * u,
    color: INK,
    threeD: true,
    lookAt: 'cameraY',
    letterSpacing: 0.2,
    transform: { x: 0, y: -330 * u, scale: 1, rotation: 0, opacity: 1, z: 0 },
  });
  const solid = (name: string, shape: 'box' | 'sphere' | 'cylinder', x: number, color: string, color2: string) =>
    b.shape(b.track(name), 0, {
      duration: len,
      name,
      kind: 'rect',
      width: 300 * u,
      height: 300 * u,
      color,
      color2,
      gradientAngle: 90,
      threeD: true,
      shape,
      shapeDepth: 300 * u,
      keyframes: { rotY: ramp(0, 360, len, 'linear') },
      transform: { x: x * u, y: 60 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotY: 0 },
    });
  solid('box', 'box', -520, '#f2f2f2', '#6b7078');
  solid('ball', 'sphere', 0, '#ffe14d', '#b3541e');
  solid('can', 'cylinder', 520, '#9ad1ff', '#27408b');
  // the floor: a flat plane lying down under the solids
  b.shape(b.track('floor'), 0, {
    duration: len,
    name: 'floor',
    kind: 'rect',
    width: 2600 * u,
    height: 1800 * u,
    color: '#24272c',
    color2: '#14161a',
    gradientRadial: true,
    threeD: true,
    transform: { x: 0, y: 215 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotX: 90 },
  });
  return b.finish(project, '#0e1013');
}

function lowerThird(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 5;
  const left = -b.w / 2 + 110 * u;
  const y = b.h / 2 - 190 * u;
  const barW = 620 * u;

  b.text(b.track('name'), 0.25, {
    duration: len - 0.25,
    name: 'name',
    text: 'first last',
    fontSize: 62 * u,
    color: '#101114',
    align: 'left',
    animIn: { id: 'slide-right', duration: 0.5 },
    fadeOut: 0.3,
    transform: { x: left + barW / 2 + 12 * u, y: y - 22 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.text(b.track('role'), 0.45, {
    duration: len - 0.45,
    name: 'role',
    text: 'what they do',
    fontSize: 34 * u,
    fontWeight: 400,
    color: INK,
    align: 'left',
    letterSpacing: 0.12,
    animIn: { id: 'fade', duration: 0.5 },
    fadeOut: 0.3,
    transform: { x: left + barW / 2 + 12 * u, y: y + 62 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.shape(b.track('bar'), 0, {
    duration: len,
    name: 'bar',
    kind: 'rect',
    width: barW,
    height: 96 * u,
    color: INK,
    radius: 0.12,
    motionIn: { id: 'slide-right', duration: 0.5 },
    motionOut: { id: 'fade', duration: 0.3 },
    transform: { x: left + barW / 2, y: y - 22 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.shape(b.track('accent'), 0.15, {
    duration: len - 0.15,
    name: 'accent',
    kind: 'rect',
    width: 14 * u,
    height: 170 * u,
    color: ACCENT,
    motionIn: { id: 'zoom-in', duration: 0.4 },
    motionOut: { id: 'fade', duration: 0.3 },
    transform: { x: left - 24 * u, y: y + 15 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  return b.finish(project, '#1a1c20');
}

function countdown(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const numbers = ['5', '4', '3', '2', '1', 'go'];
  const len = numbers.length;

  const digits = b.track('numbers');
  numbers.forEach((n, i) => {
    b.text(digits, i, {
      duration: 1,
      name: n,
      text: n,
      fontSize: (n === 'go' ? 300 : 420) * u,
      color: n === 'go' ? ACCENT : INK,
      animIn: { id: 'pop', duration: 0.3 },
      animOut: { id: 'fade', duration: 0.2 },
    });
  });
  const ring = b.track('ring');
  numbers.forEach((n, i) => {
    b.shape(ring, i, {
      duration: 1,
      name: 'ring',
      kind: 'ellipse',
      width: 760 * u,
      height: 760 * u,
      filled: false,
      color: DIM,
      stroke: { color: n === 'go' ? ACCENT : DIM, width: 10 * u },
      keyframes: { scale: ramp(0.7, 1.15, 1, 'ease-out'), opacity: ramp(1, 0, 1, 'ease-in') },
    });
  });
  b.shape(b.track('cross'), 0, {
    duration: len,
    name: 'cross',
    kind: 'line',
    width: Math.hypot(b.w, b.h),
    height: 4 * u,
    color: '#2a2d33',
    motionLoop: { id: 'rotate', duration: 4 },
  });
  return b.finish(project, '#0b0c0e');
}

function lyrics(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const lines = ['sing the first line here', 'then the second one follows', 'every word lights up in time', 'change the words and the timing'];
  const each = 3;
  const len = lines.length * each;

  b.effect(b.track('grain'), 'grain', 0, { duration: len, amount: 0.5 });
  const words = b.track('words');
  lines.forEach((line, i) => {
    b.text(words, i * each, {
      duration: each,
      name: line.split(' ').slice(0, 3).join(' '),
      text: line,
      fontSize: 84 * u,
      color: '#6f747d',
      wrapWidth: Math.round(b.w * 0.8),
      highlight: { color: ACCENT, mode: 'fill' },
      animIn: { id: 'rise', duration: 0.4 },
      animOut: { id: 'fade', duration: 0.3 },
    });
  });
  b.shape(b.track('disc'), 0, {
    duration: len,
    name: 'disc',
    kind: 'ellipse',
    width: 1500 * u,
    height: 1500 * u,
    color: '#1d2026',
    color2: '#0b0c0e',
    gradientRadial: true,
    motionLoop: { id: 'pulse', duration: 1.5 },
  });
  return b.finish(project, '#0b0c0e');
}

function stats(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 6;
  // side by side only when there is room for three numbers: near-square canvases stack them
  const wide = b.w >= b.h * 1.6;
  const items: { text: string; to: number; decimals: number; separator: boolean; label: string }[] = [
    { text: '{n}%', to: 87, decimals: 0, separator: false, label: 'happier' },
    { text: '{n}', to: 12500, decimals: 0, separator: true, label: 'views' },
    { text: '{n}x', to: 3.5, decimals: 1, separator: false, label: 'faster' },
  ];
  const gap = wide ? Math.min(600 * u, b.w * 0.3) : 420 * u;
  items.forEach((item, i) => {
    const x = wide ? (i - 1) * gap : 0;
    const y = wide ? 0 : (i - 1) * gap;
    const start = i * 0.4;
    b.text(b.track(`number ${i + 1}`), start, {
      duration: len - start,
      name: item.label,
      text: item.text,
      fontSize: 180 * u,
      fontWeight: 700,
      color: i === 1 ? ACCENT : INK,
      counter: { from: 0, to: item.to, decimals: item.decimals, separator: item.separator, ease: 'out', hold: 1.5 },
      animIn: { id: 'rise', duration: 0.5 },
      transform: { x, y: y - 40 * u, scale: 1, rotation: 0, opacity: 1 },
    });
    b.text(b.track(`label ${i + 1}`), start + 0.2, {
      duration: len - start - 0.2,
      name: `${item.label} label`,
      text: item.label,
      fontSize: 50 * u,
      color: DIM,
      letterSpacing: 0.15,
      underline: true,
      animIn: { id: 'fade', duration: 0.5 },
      transform: { x, y: y + 110 * u, scale: 1, rotation: 0, opacity: 1 },
    });
  });
  return b.finish(project, '#0b0c0e');
}

function winter(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 6;

  b.effect(b.track('snow'), 'snow', 0, { duration: len, fadeIn: 0.8, amount: 0.85 });
  b.text(b.track('title'), 0.3, {
    duration: len - 0.3,
    name: 'title',
    text: 'first snow',
    fontSize: 190 * u,
    fontWeight: 700,
    color: INK,
    extrude: { depth: 0.07, angle: 60, color: '#51618a' },
    animIn: { id: 'cascade', duration: 1.2 },
    transform: { x: 0, y: -30 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.text(b.track('line'), 1.4, {
    duration: len - 1.4,
    name: 'line',
    text: 'change the words, keep the weather',
    fontSize: 44 * u,
    color: '#c9d3ea',
    letterSpacing: 0.12,
    wrapWidth: Math.round(b.w * 0.8),
    animIn: { id: 'fade', duration: 0.8 },
    transform: { x: 0, y: 150 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.effect(b.track('mist'), 'mist', 0, { duration: len, amount: 0.7 });
  b.shape(b.track('sky'), 0, {
    duration: len,
    name: 'sky',
    kind: 'rect',
    width: b.w,
    height: b.h,
    color: '#141d33',
    color2: '#46527a',
    gradientAngle: 90,
  });
  return b.finish(project, '#141d33');
}

function carousel(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 8;
  const count = 8;
  const radius = 560 * u;

  b.camera(b.track('camera'), 0, {
    duration: len,
    tilt: -10,
    y: -230 * u,
    keyframes: { z: ramp(-650 * u, -200 * u, len, 'ease-out') },
  });
  // everything on the ring is attached to the pole: turn the pole and the cards go around
  const pole = b.shape(b.track('pole'), 0, {
    duration: len,
    name: 'pole',
    kind: 'rect',
    width: 36 * u,
    height: 520 * u,
    color: '#3a3e46',
    color2: '#1c1e23',
    gradientAngle: 90,
    threeD: true,
    shape: 'cylinder',
    shapeDepth: 36 * u,
    keyframes: { rotY: ramp(0, 360, len, 'linear') },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0, rotY: 0 },
  });
  const tones = ['#f2f2f2', '#ffe14d', '#9ad1ff', '#8a8f98'];
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2;
    b.shape(b.track(`card ${i + 1}`), 0, {
      duration: len,
      name: `card ${i + 1}`,
      kind: 'rect',
      width: 300 * u,
      height: 400 * u,
      color: tones[i % tones.length]!,
      color2: '#22252b',
      gradientAngle: 90,
      radius: 0.08,
      threeD: true,
      parent: pole.id,
      // around the pole, each card turned to face away from it
      transform: { x: Math.sin(a) * radius, y: 0, scale: 1, rotation: 0, opacity: 1, z: -Math.cos(a) * radius, rotY: (i / count) * 360 },
    });
  }
  b.shape(b.track('floor'), 0, {
    duration: len,
    name: 'floor',
    kind: 'ellipse',
    width: 2200 * u,
    height: 2200 * u,
    color: '#24272c',
    color2: '#101215',
    gradientRadial: true,
    threeD: true,
    transform: { x: 0, y: 275 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotX: 90 },
  });
  return b.finish(project, '#0e1013');
}

function rackFocus(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 7;
  // the distance from the home camera to the z = 0 plane (see scene3d/camera.ts homeDistance)
  const home = b.h / 2 / Math.tan((50 * Math.PI) / 360);
  const spots = [
    { name: 'near', x: -300 * u, z: -380 * u, color: '#ff8a6b' },
    { name: 'middle', x: 130 * u, z: 160 * u, color: ACCENT },
    { name: 'far', x: 760 * u, z: 800 * u, color: '#9ad1ff' },
  ];
  const at = (z: number) => home + z;

  // the focus is pulled from the near card to the far one and back to the middle: keys on focusDistance
  b.camera(b.track('camera'), 0, {
    duration: len,
    focusStrength: 0.85,
    focusDistance: at(spots[0]!.z),
    keyframes: {
      focusDistance: [
        { t: 0, v: at(spots[0]!.z), ease: 'ease' },
        { t: 1.5, v: at(spots[0]!.z), ease: 'ease' },
        { t: 3, v: at(spots[2]!.z), ease: 'ease' },
        { t: 4.5, v: at(spots[2]!.z), ease: 'ease' },
        { t: 6, v: at(spots[1]!.z), ease: 'ease' },
      ],
      x: ramp(-70 * u, 70 * u, len, 'linear'),
    },
  });
  // flat layers are never blurred: this line stays sharp the whole time
  b.text(b.track('caption'), 0.4, {
    duration: len - 0.4,
    name: 'caption',
    text: 'pull the focus',
    fontSize: 46 * u,
    color: DIM,
    letterSpacing: 0.2,
    animIn: { id: 'fade', duration: 0.6 },
    transform: { x: 0, y: b.h / 2 - 90 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  for (const s of spots) {
    b.text(b.track(`${s.name} label`), 0, {
      duration: len,
      name: `${s.name} label`,
      text: s.name,
      fontSize: 84 * u,
      fontWeight: 700,
      color: '#111111',
      threeD: true,
      transform: { x: s.x, y: 0, scale: 1, rotation: 0, opacity: 1, z: s.z - 4 * u, rotY: 0 },
    });
  }
  for (const s of spots) {
    b.shape(b.track(s.name), 0, {
      duration: len,
      name: s.name,
      kind: 'rect',
      width: 380 * u,
      height: 520 * u,
      color: s.color,
      color2: '#1a1c20',
      gradientAngle: 90,
      radius: 0.07,
      threeD: true,
      transform: { x: s.x, y: 0, scale: 1, rotation: 0, opacity: 1, z: s.z, rotY: 0 },
    });
  }
  return b.finish(project, '#0c0d10');
}

function timer(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 10;

  b.text(b.track('label'), 0, {
    duration: len,
    name: 'label',
    text: 'starting in',
    fontSize: 54 * u,
    color: DIM,
    letterSpacing: 0.2,
    animIn: { id: 'fade', duration: 0.5 },
    transform: { x: 0, y: -215 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  // seconds, written as m:ss. steady digits keep the colon where it is while the number runs
  b.text(b.track('timer'), 0, {
    duration: len,
    name: 'timer',
    text: '{n}',
    fontSize: 300 * u,
    fontWeight: 700,
    color: INK,
    counter: { from: len, to: 0, decimals: 0, ease: 'linear', format: 'time', fixedWidth: true },
    transform: { x: 0, y: 20 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  // a bar that runs out with the time
  b.shape(b.track('bar'), 0, {
    duration: len,
    name: 'bar',
    kind: 'rect',
    width: 760 * u,
    height: 10 * u,
    color: ACCENT,
    keyframes: { scale: ramp(1, 0.02, len, 'linear') },
    transform: { x: 0, y: 230 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  return b.finish(project, '#0b0c0e');
}

function blockTitle(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 6;

  b.camera(b.track('camera'), 0, { duration: len, keyframes: { z: ramp(-420 * u, 0, len, 'ease-out') } });
  // a line of flat text: it stays put while the letters turn
  b.text(b.track('caption'), 0.8, {
    duration: len - 0.8,
    name: 'caption',
    text: 'a line under it',
    fontSize: 50 * u,
    fontWeight: 400,
    color: DIM,
    letterSpacing: 0.3,
    fadeIn: 0.6,
    fadeOut: 0.4,
    transform: { x: 0, y: b.h / 2 - 120 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  // block depth on a 3d text is real: the letters have a side when they turn
  b.text(b.track('title'), 0, {
    duration: len,
    name: 'title',
    text: 'block',
    uppercase: true,
    fontSize: 330 * u,
    fontWeight: 700,
    color: ACCENT,
    letterSpacing: 0.03,
    threeD: true,
    extrude: { depth: 0.3, angle: 45, color: '#a8551c' },
    fadeIn: 0.3,
    fadeOut: 0.4,
    keyframes: {
      rotY: [
        { t: 0, v: -58, ease: 'ease-out' },
        { t: 2.4, v: 30, ease: 'ease' },
        { t: len, v: -16, ease: 'ease' },
      ],
      rotX: ramp(-24, -8, len, 'ease-out'),
    },
    transform: { x: 0, y: -40 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotX: -24, rotY: -58 },
  });
  const solid = (name: string, shape: 'star' | 'heart' | 'hexagon', x: number, y: number, z: number, color: string, color2: string, spin: number) =>
    b.shape(b.track(name), 0, {
      duration: len,
      name,
      kind: 'rect',
      width: 230 * u,
      height: 230 * u,
      color,
      color2,
      gradientAngle: 90,
      threeD: true,
      shape,
      shapeDepth: 70 * u,
      fadeIn: 0.4,
      fadeOut: 0.4,
      keyframes: { rotY: ramp(20, 20 + spin, len, 'linear') },
      transform: { x: x * u, y: y * u, scale: 1, rotation: 0, opacity: 1, z: z * u, rotX: -14, rotY: 20 },
    });
  solid('star', 'star', -820, -290, 260, '#fff2a8', '#ff9f1c', 360);
  solid('heart', 'heart', 700, 210, 140, '#ff9ebb', '#c9184a', -360);
  solid('hexagon', 'hexagon', 640, -300, 620, '#9ad1ff', '#27408b', 300);
  return b.finish(project, '#0d0e12');
}

function tunnel(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 6;
  const frames = 14;
  const gap = 420 * u;

  // the camera flies down the row of frames (what the repeat tool makes from one frame: a step in z and a turn)
  b.camera(b.track('camera'), 0, { duration: len, keyframes: { z: ramp(-300 * u, gap * (frames - 2), len, 'ease'), roll: ramp(50, 0, len, 'ease-out') } });
  b.text(b.track('title'), 0, {
    duration: len,
    name: 'title',
    text: 'the end of\nthe tunnel',
    fontSize: 190 * u,
    fontWeight: 700,
    color: ACCENT,
    threeD: true,
    fadeOut: 0.4,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: gap * frames },
  });
  for (let i = 0; i < frames; i++) {
    b.shape(b.track(`frame ${i + 1}`), 0, {
      duration: len,
      name: `frame ${i + 1}`,
      kind: 'rect',
      width: 1500 * u,
      height: 860 * u,
      filled: false,
      color: INK,
      stroke: { color: i % 3 === 0 ? ACCENT : INK, width: 14 * u },
      radius: 0.06,
      threeD: true,
      fadeOut: 0.4,
      transform: { x: 0, y: 0, scale: 1, rotation: i * 9, opacity: 1, z: i * gap },
    });
  }
  return { ...b.finish(project, '#090a0d'), fog: { color: '#090a0d', near: 2600 * u, far: gap * 11, amount: 1 } };
}

function letterRing(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 8;
  const word = 'all the way around ';
  const radius = 520 * u;

  b.camera(b.track('camera'), 0, { duration: len, tilt: -12, y: -260 * u, keyframes: { z: ramp(-500 * u, -150 * u, len, 'ease-out') } });
  // every letter is a clip of its own (what "split into letters" gives), attached to a hub that turns
  const hub = b.shape(b.track('hub'), 0, {
    duration: len,
    name: 'hub',
    kind: 'ellipse',
    width: 180 * u,
    height: 180 * u,
    color: ACCENT,
    color2: '#ff9f1c',
    gradientAngle: 90,
    threeD: true,
    shape: 'sphere',
    keyframes: { rotY: ramp(0, -360, len, 'linear') },
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, z: 0, rotY: 0 },
  });
  const letters = [...word];
  letters.forEach((ch, i) => {
    if (ch === ' ') return;
    const a = (i / letters.length) * Math.PI * 2;
    b.text(b.track(`letter ${i + 1}`), 0, {
      duration: len,
      name: ch,
      text: ch,
      uppercase: true,
      fontSize: 150 * u,
      fontWeight: 700,
      color: INK,
      threeD: true,
      parent: hub.id,
      extrude: { depth: 0.18, angle: 45, color: '#5b6270' },
      transform: { x: Math.sin(a) * radius, y: 0, scale: 1, rotation: 0, opacity: 1, z: -Math.cos(a) * radius, rotY: (i / letters.length) * 360 },
    });
  });
  b.shape(b.track('floor'), 0, {
    duration: len,
    name: 'floor',
    kind: 'ellipse',
    width: 2000 * u,
    height: 2000 * u,
    color: '#22252b',
    color2: '#0e1013',
    gradientRadial: true,
    threeD: true,
    transform: { x: 0, y: 200 * u, scale: 1, rotation: 0, opacity: 1, z: 0, rotX: 90 },
  });
  return b.finish(project, '#0e1013');
}

/** a number 0 .. 1 from two indices, the same every time (templates never use Math.random) */
function steady(i: number, k: number): number {
  const s = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * keys of a circle in the ground plane around the middle of the scene (what the "path" tool writes): `laps` times
 * around in `len` seconds, starting at angle a0 (0 = the point nearest to the camera). `lift` tips the orbit.
 */
function orbitKeys(radius: number, a0: number, laps: number, len: number, lift = 0): Keyframes {
  const n = Math.max(12, Math.round(24 * Math.abs(laps)));
  const x: Keyframes[string] = [];
  const y: Keyframes[string] = [];
  const z: Keyframes[string] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * laps * Math.PI * 2;
    const t = (i / n) * len;
    x.push({ t, v: Math.sin(a) * radius, ease: 'linear' });
    y.push({ t, v: Math.sin(a) * lift, ease: 'linear' });
    z.push({ t, v: -Math.cos(a) * radius, ease: 'linear' });
  }
  return lift !== 0 ? { x, y, z } : { x, z };
}

function orbit(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 8;
  const at = (x: number, y: number, z: number) => ({ x, y, scale: 1, rotation: 0, opacity: 1, z });

  b.camera(b.track('camera'), 0, { duration: len, tilt: -17, y: -640 * u, keyframes: { z: ramp(-1150 * u, -700 * u, len, 'ease-out') } });
  // flat 2d text over the 3d scene
  b.text(b.track('title'), 0, {
    duration: len,
    name: 'title',
    text: 'orbit',
    fontSize: 120 * u,
    fontWeight: 700,
    color: INK,
    align: 'left',
    animIn: { id: 'typewriter', duration: 0.8 },
    fadeOut: 0.4,
    transform: { x: -b.w / 2 + 250 * u, y: b.h / 2 - 170 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.text(b.track('line'), 0.6, {
    duration: len - 0.6,
    name: 'line',
    text: 'every ball follows a path',
    fontSize: 40 * u,
    color: DIM,
    align: 'left',
    fadeIn: 0.5,
    fadeOut: 0.4,
    transform: { x: -b.w / 2 + 370 * u, y: b.h / 2 - 90 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.shape(b.track('sun'), 0, {
    duration: len,
    name: 'sun',
    kind: 'ellipse',
    width: 300 * u,
    height: 300 * u,
    color: ACCENT,
    color2: '#ff9f1c',
    gradientAngle: 90,
    threeD: true,
    shape: 'sphere',
    motionLoop: { id: 'pulse', duration: 2 },
    transform: at(0, 0, 0),
  });
  const balls = [
    { name: 'near', size: 90, radius: 380, a0: 0.4, laps: 2, lift: 0, color: '#7fd1ff', color2: '#2b6cff' },
    { name: 'middle', size: 140, radius: 640, a0: 2.2, laps: 1, lift: 60, color: '#ff7a59', color2: '#b3261e' },
    { name: 'far', size: 80, radius: 900, a0: 4.1, laps: -0.75, lift: -40, color: INK, color2: DIM },
  ];
  for (const p of balls) {
    const ball = b.shape(b.track(p.name), 0, {
      duration: len,
      name: p.name,
      kind: 'ellipse',
      width: p.size * u,
      height: p.size * u,
      color: p.color,
      color2: p.color2,
      gradientAngle: 90,
      threeD: true,
      shape: 'sphere',
      keyframes: orbitKeys(p.radius * u, p.a0, p.laps, len, p.lift * u),
      transform: at(Math.sin(p.a0) * p.radius * u, Math.sin(p.a0) * p.lift * u, -Math.cos(p.a0) * p.radius * u),
    });
    if (p.name === 'middle') {
      // a moon: attached to its ball, with a path of its own around it
      b.shape(b.track('moon'), 0, {
        duration: len,
        name: 'moon',
        kind: 'ellipse',
        width: 44 * u,
        height: 44 * u,
        color: INK,
        color2: DIM,
        gradientAngle: 90,
        threeD: true,
        shape: 'sphere',
        parent: ball.id,
        keyframes: orbitKeys(150 * u, 0, 5, len),
        transform: at(0, 0, -150 * u),
      });
    }
  }
  // the orbits drawn on the ground
  for (const p of balls) {
    b.shape(b.track(`orbit ${p.name}`), 0, {
      duration: len,
      name: `orbit ${p.name}`,
      kind: 'ellipse',
      width: p.radius * 2 * u,
      height: p.radius * 2 * u,
      filled: false,
      color: DIM,
      stroke: { color: '#3a3f47', width: 4 * u },
      threeD: true,
      transform: { ...at(0, 0, 0), rotX: 90 },
    });
  }
  return b.finish(project, '#08090c');
}

function lettersIn(project: Project): Project {
  const b = new Builder(project);
  const u = b.u;
  const len = 5;
  const fps = project.fps > 0 ? project.fps : 30;
  const word = 'one by one';
  const size = 170 * u;
  // the default font is monospace: every letter is as wide as the next
  const advance = size * 0.62;
  const letters = [...word];
  const fly = 0.6;

  // what "split into letters" + "cascade" make: a clip per letter, each starting two frames after the one before,
  // flying in from a scattered place and falling out at the end
  letters.forEach((ch, i) => {
    if (ch === ' ') return;
    const start = (i * 2) / fps;
    const duration = len - start;
    const x = (i - (letters.length - 1) / 2) * advance;
    const fromX = x + (steady(i, 1) - 0.5) * 900 * u;
    const fromY = (steady(i, 2) - 0.5) * 700 * u;
    const turn = (steady(i, 3) - 0.5) * 240;
    b.text(b.track(`letter ${i + 1}`), start, {
      duration,
      name: ch,
      text: ch,
      fontSize: size,
      fontWeight: 700,
      color: i % 4 === 0 ? ACCENT : INK,
      keyframes: {
        x: [
          { t: 0, v: fromX, ease: 'ease-out' },
          { t: fly, v: x, ease: 'linear' },
        ],
        y: [
          { t: 0, v: fromY, ease: 'ease-out' },
          { t: fly, v: -40 * u, ease: 'linear' },
          { t: duration - 0.5, v: -40 * u, ease: 'ease-in' },
          { t: duration, v: 500 * u, ease: 'linear' },
        ],
        rotation: [
          { t: 0, v: turn, ease: 'ease-out' },
          { t: fly, v: 0, ease: 'linear' },
          { t: duration - 0.5, v: 0, ease: 'ease-in' },
          { t: duration, v: -turn / 2, ease: 'linear' },
        ],
        opacity: [
          { t: 0, v: 0, ease: 'ease-out' },
          { t: fly, v: 1, ease: 'linear' },
          { t: duration - 0.5, v: 1, ease: 'ease-in' },
          { t: duration, v: 0, ease: 'linear' },
        ],
      },
      transform: { x, y: -40 * u, scale: 1, rotation: 0, opacity: 1 },
    });
  });
  b.text(b.track('line'), 1.2, {
    duration: len - 1.2,
    name: 'line',
    text: 'every letter is a clip of its own',
    fontSize: 46 * u,
    color: DIM,
    animIn: { id: 'words', duration: 0.9 },
    fadeOut: 0.4,
    transform: { x: 0, y: 150 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  b.shape(b.track('rule'), 0.9, {
    duration: len - 0.9,
    name: 'rule',
    kind: 'rect',
    width: advance * letters.length,
    height: 6 * u,
    color: ACCENT,
    motionIn: { id: 'zoom-in', duration: 0.5 },
    fadeOut: 0.4,
    transform: { x: 0, y: 80 * u, scale: 1, rotation: 0, opacity: 1 },
  });
  return b.finish(project, '#0e1013');
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'title-3d', name: 'title in space', description: 'a 3d title with shapes at different depths and a camera that flies in', build: titleInSpace },
  { id: 'solids-3d', name: '3d shapes', description: 'a box, a ball and a can turning on a floor while the camera passes by', build: solids },
  { id: 'lower-third', name: 'name tag', description: 'a name and a role sliding in at the bottom left', build: lowerThird },
  { id: 'countdown', name: 'countdown', description: 'five to one with a ring that pops on every number', build: countdown },
  { id: 'lyrics', name: 'lyrics', description: 'lines whose words light up one after another', build: lyrics },
  { id: 'stats', name: 'numbers', description: 'three numbers that count up, each with a label under it', build: stats },
  { id: 'winter', name: 'snow title', description: 'a block title in falling snow and mist over an evening sky', build: winter },
  { id: 'carousel', name: 'carousel', description: 'eight cards on a turning ring in 3d: they are attached to the pole in the middle', build: carousel },
  { id: 'rack-focus', name: 'rack focus', description: 'three cards at different depths while the camera pulls the focus from one to the next', build: rackFocus },
  { id: 'block-title', name: 'block title', description: 'thick 3d letters that turn, with a star, a heart and a hexagon spinning around them', build: blockTitle },
  { id: 'tunnel', name: 'tunnel', description: 'a row of frames into the distance, each turned a little more, and a camera that flies through them', build: tunnel },
  { id: 'letter-ring', name: 'letter ring', description: 'a sentence standing in a circle, every letter its own 3d clip, turning around a hub', build: letterRing },
  { id: 'orbit', name: 'orbit', description: 'balls circling a sun on paths of their own, one with a moon attached, under a flat title', build: orbit },
  { id: 'letters-in', name: 'letters fly in', description: 'a word whose letters fly in one after the other and fall out together', build: lettersIn },
  { id: 'timer', name: 'timer', description: 'a ten second count down written as m:ss, with a bar that runs out', build: timer },
];

export function getTemplate(id: string | null | undefined): ProjectTemplate | undefined {
  return id ? PROJECT_TEMPLATES.find((t) => t.id === id) : undefined;
}
