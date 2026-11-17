import { describe, expect, it } from 'vitest';
import { getEffect } from '../engine/effects/registry';
import { CLIP_MOTIONS_IN, CLIP_MOTIONS_LOOP, CLIP_MOTIONS_OUT } from '../engine/clipAnim';
import { TEXT_ANIMS_IN, TEXT_ANIMS_LOOP, TEXT_ANIMS_OUT } from '../engine/textAnim';
import type { Clip, Project } from '../types';
import { isVisualClip } from '../types';
import { CANVAS_PRESETS, createProject } from './factory';
import { getClipBox } from '../engine/draw';
import { pictureBox } from '../engine/pivot';
import { bendMembers, fitBend } from '../features/properties/bendGroup';
import { worldClip } from '../features/preview/attached';
import { PROJECT_TEMPLATES, getTemplate } from './templates';
import { projectDuration } from './timelineOps';

const ids = (list: { id: string }[]) => new Set(list.map((x) => x.id));

function numbers(value: unknown, path: string, out: string[]): void {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) out.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => numbers(v, `${path}[${i}]`, out));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) numbers(v, `${path}.${k}`, out);
  }
}

function check(p: Project): void {
  // tracks: pictures first, then audio, unique ids
  const trackIds = p.tracks.map((t) => t.id);
  expect(new Set(trackIds).size).toBe(trackIds.length);
  const firstAudio = p.tracks.findIndex((t) => t.kind === 'audio');
  if (firstAudio >= 0) expect(p.tracks.slice(firstAudio).every((t) => t.kind === 'audio')).toBe(true);

  const clipIds = p.clips.map((c) => c.id);
  expect(new Set(clipIds).size).toBe(clipIds.length);
  expect(p.clips.length).toBeGreaterThan(0);

  const byTrack = new Map<string, Clip[]>();
  for (const c of p.clips) {
    const track = p.tracks.find((t) => t.id === c.trackId);
    expect(track, `clip ${c.name} has a track`).toBeTruthy();
    expect(track!.kind).toBe('video');
    expect(c.start).toBeGreaterThanOrEqual(0);
    expect(c.duration).toBeGreaterThan(0);
    expect(c.fadeIn + c.fadeOut).toBeLessThanOrEqual(c.duration + 1e-9);
    byTrack.set(c.trackId, [...(byTrack.get(c.trackId) ?? []), c]);
    const bad: string[] = [];
    numbers(c, c.name, bad);
    expect(bad).toEqual([]);
    for (const keys of Object.values(c.keyframes ?? {})) {
      for (let i = 0; i < keys.length; i++) {
        expect(keys[i]!.t).toBeGreaterThanOrEqual(0);
        expect(keys[i]!.t).toBeLessThanOrEqual(c.duration + 1e-9);
        if (i > 0) expect(keys[i]!.t).toBeGreaterThan(keys[i - 1]!.t);
      }
    }
    if (c.type === 'effect') expect(getEffect(c.effect), `effect ${c.effect}`).toBeTruthy();
    if (c.type === 'text') {
      if (c.animIn) expect(ids(TEXT_ANIMS_IN).has(c.animIn.id)).toBe(true);
      if (c.animOut) expect(ids(TEXT_ANIMS_OUT).has(c.animOut.id)).toBe(true);
      if (c.animLoop) expect(ids(TEXT_ANIMS_LOOP).has(c.animLoop.id)).toBe(true);
    }
    if (isVisualClip(c)) {
      if (c.motionIn) expect(ids(CLIP_MOTIONS_IN).has(c.motionIn.id)).toBe(true);
      if (c.motionOut) expect(ids(CLIP_MOTIONS_OUT).has(c.motionOut.id)).toBe(true);
      if (c.motionLoop) expect(ids(CLIP_MOTIONS_LOOP).has(c.motionLoop.id)).toBe(true);
    }
  }
  // clips on one track never overlap
  for (const list of byTrack.values()) {
    list.sort((a, b) => a.start - b.start);
    for (let i = 1; i < list.length; i++) {
      expect(list[i]!.start).toBeGreaterThanOrEqual(list[i - 1]!.start + list[i - 1]!.duration - 1e-9);
    }
  }
  // no empty tracks left behind
  for (const t of p.tracks) if (t.kind === 'video') expect(byTrack.has(t.id), `track ${t.name} is used`).toBe(true);
}

describe('project templates', () => {
  it('have unique ids, names and descriptions', () => {
    expect(new Set(PROJECT_TEMPLATES.map((t) => t.id)).size).toBe(PROJECT_TEMPLATES.length);
    for (const t of PROJECT_TEMPLATES) {
      expect(t.name).toBe(t.name.toLowerCase());
      expect(t.description.length).toBeGreaterThan(10);
    }
    expect(getTemplate('countdown')?.id).toBe('countdown');
    expect(getTemplate('nope')).toBeUndefined();
    expect(getTemplate(null)).toBeUndefined();
  });

  for (const t of PROJECT_TEMPLATES) {
    for (const preset of CANVAS_PRESETS) {
      it(`${t.id} builds a valid project at ${preset.id}`, () => {
        const empty = createProject('x', preset, 30);
        const p = t.build(empty);
        expect(p.id).toBe(empty.id);
        expect(p.name).toBe('x');
        expect(p.width).toBe(preset.width);
        expect(p.height).toBe(preset.height);
        expect(p.tracks.filter((x) => x.kind === 'audio')).toHaveLength(1);
        expect(projectDuration(p)).toBeGreaterThan(2);
        check(p);
      });
    }
  }

  it('lit room lights its 3d clips from the scene', () => {
    const p = getTemplate('lit-room')!.build(createProject('x'));
    expect(p.clips.some((c) => isVisualClip(c) && (c.lit ?? 0) > 0)).toBe(true);
    const title = p.clips.find((c) => c.name === 'title')!;
    expect(isVisualClip(title) && title.lit).toBeFalsy();
    expect(p.light).toBeUndefined();
    const bottom = p.tracks.filter((t) => t.kind === 'video').at(-1)!;
    const under = p.clips.filter((c) => c.trackId === bottom.id);
    expect(under).toHaveLength(1);
    expect(under[0]!.type).toBe('shape');
    expect(isVisualClip(under[0]!) && under[0]!.threeD).toBeFalsy();
  });

  it('builds the same timeline twice apart from ids', () => {
    // ids differ between two builds: links between clips are compared by position instead
    const at = (p: Project, id: unknown) => (typeof id === 'string' ? p.clips.findIndex((c) => c.id === id) : id);
    const strip = (p: Project) =>
      JSON.stringify(
        p.clips.map((c) => {
          const o: Record<string, unknown> = { ...c, id: '', trackId: p.tracks.findIndex((t) => t.id === c.trackId) };
          for (const k of ['parent', 'lookTarget', 'target']) if (k in o) o[k] = at(p, o[k]);
          return o;
        }),
      );
    for (const t of PROJECT_TEMPLATES) {
      const a = t.build(createProject('a'));
      const b = t.build(createProject('b'));
      expect(strip(a)).toBe(strip(b));
    }
  });

  it('curved wall: five cards share one group and span, center -x / W', () => {
    const p = getTemplate('curved-wall')!.build(createProject('x'));
    const u = Math.min(p.width, p.height) / 1080;
    const W = 5 * 300 * u + 4 * 40 * u;
    const cards = p.clips.filter((c) => c.name.startsWith('card '));
    expect(cards).toHaveLength(5);
    const group = cards[0]!.group;
    expect(group).toBeTruthy();
    for (const c of cards) {
      if (!isVisualClip(c)) throw new Error('card is not visual');
      expect(c.group).toBe(group);
      expect(c.bend?.angle).toBe(120);
      expect(c.bend?.span).toBeCloseTo(W, 9);
      expect(c.bend?.center ?? 0).toBeCloseTo(-c.transform.x / W, 9);
    }
    // the title is on the same tube, and the page keeps its own bend keys
    const title = p.clips.find((c) => c.name === 'title')!;
    expect(isVisualClip(title) && title.group).toBe(group);
    expect(isVisualClip(title) && title.bend?.span).toBeCloseTo(W, 9);
    const page = p.clips.find((c) => c.name === 'page')!;
    expect(page.keyframes?.['bend.angle']).toHaveLength(2);
    // the same numbers 'bend together' fits
    const fit = fitBend(bendMembers(p, cards.filter(isVisualClip), 0), 'width', 0)!;
    expect(fit.onePlane).toBe(true);
    for (const c of cards) {
      const f = fit.per.get(c.id)!;
      expect(f.span).toBeCloseTo(W, 6);
      expect(f.center).toBeCloseTo(isVisualClip(c) ? (c.bend?.center ?? 0) : 0, 9);
    }
  });

  it('pivots: every joint holds while the arm moves', () => {
    const p = getTemplate('pivots')!.build(createProject('x'));
    const named = (n: string) => p.clips.find((c) => c.name === n)!;
    const visual = (n: string) => {
      const c = named(n);
      if (!isVisualClip(c)) throw new Error(`${n} is not visual`);
      return c;
    };
    const boxAt = (n: string, t: number) => getClipBox(p, worldClip(p, visual(n), t));
    // the middle of the right edge of a picture
    const rightEnd = (n: string, t: number) => {
      const pb = pictureBox(boxAt(n, t));
      const a = (pb.rotation * Math.PI) / 180;
      return { x: pb.cx + (Math.cos(a) * pb.width) / 2, y: pb.cy + (Math.sin(a) * pb.width) / 2 };
    };
    for (let t = 0; t <= 5.75; t += 0.25) {
      const fore = boxAt('forearm', t);
      const upperEnd = rightEnd('upper arm', t);
      expect(fore.cx).toBeCloseTo(upperEnd.x, 6);
      expect(fore.cy).toBeCloseTo(upperEnd.y, 6);
      const hand = boxAt('hand', t);
      const foreEnd = rightEnd('forearm', t);
      expect(hand.cx).toBeCloseTo(foreEnd.x, 6);
      expect(hand.cy).toBeCloseTo(foreEnd.y, 6);
    }
  });

  it('pivots: the minute hand rotates around the face middle', () => {
    const p = getTemplate('pivots')!.build(createProject('x'));
    const named = (n: string) => {
      const c = p.clips.find((x) => x.name === n)!;
      if (!isVisualClip(c)) throw new Error(`${n} is not visual`);
      return c;
    };
    const u = Math.min(p.width, p.height) / 1080;
    for (const t of [0, 0.5, 1.5, 3, 4.25, 6]) {
      const face = getClipBox(p, worldClip(p, named('clock face'), t));
      for (const [n, len] of [['minute hand', 150], ['hour hand', 100]] as const) {
        const box = getClipBox(p, worldClip(p, named(n), t));
        // the pivot stays on the face middle
        expect(box.cx).toBeCloseTo(face.cx, 6);
        expect(box.cy).toBeCloseTo(face.cy, 6);
        // the picture middle is half the hand away from it, along the hand's own axis
        const pb = pictureBox(box);
        expect(Math.hypot(pb.cx - face.cx, pb.cy - face.cy)).toBeCloseTo((len * u) / 2, 6);
        const a = (box.rotation * Math.PI) / 180;
        expect(pb.cx - face.cx).toBeCloseTo((len * u) / 2 * Math.sin(a), 6);
        expect(pb.cy - face.cy).toBeCloseTo(-(len * u) / 2 * Math.cos(a), 6);
      }
    }
  });
});
