import { describe, expect, it } from 'vitest';
import { getEffect } from '../engine/effects/registry';
import { CLIP_MOTIONS_IN, CLIP_MOTIONS_LOOP, CLIP_MOTIONS_OUT } from '../engine/clipAnim';
import { TEXT_ANIMS_IN, TEXT_ANIMS_LOOP, TEXT_ANIMS_OUT } from '../engine/textAnim';
import type { Clip, Project } from '../types';
import { isVisualClip } from '../types';
import { CANVAS_PRESETS, createProject } from './factory';
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

  it('builds the same timeline twice apart from ids', () => {
    const strip = (p: Project) =>
      JSON.stringify(p.clips.map((c) => ({ ...c, id: '', trackId: p.tracks.findIndex((t) => t.id === c.trackId) })));
    for (const t of PROJECT_TEMPLATES) {
      const a = t.build(createProject('a'));
      const b = t.build(createProject('b'));
      expect(strip(a)).toBe(strip(b));
    }
  });
});
