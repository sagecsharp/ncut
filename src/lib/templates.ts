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

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  { id: 'title-3d', name: 'title in space', description: 'a 3d title with shapes at different depths and a camera that flies in', build: titleInSpace },
  { id: 'solids-3d', name: '3d shapes', description: 'a box, a ball and a can turning on a floor while the camera passes by', build: solids },
  { id: 'lower-third', name: 'name tag', description: 'a name and a role sliding in at the bottom left', build: lowerThird },
  { id: 'countdown', name: 'countdown', description: 'five to one with a ring that pops on every number', build: countdown },
  { id: 'lyrics', name: 'lyrics', description: 'lines whose words light up one after another', build: lyrics },
];

export function getTemplate(id: string | null | undefined): ProjectTemplate | undefined {
  return id ? PROJECT_TEMPLATES.find((t) => t.id === id) : undefined;
}
