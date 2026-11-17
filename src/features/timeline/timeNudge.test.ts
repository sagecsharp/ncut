import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, EffectClip, ImageClip, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { moveClipsIn } from '../../store/editorStore';
import type { ClipMove } from '../../store/editorStore';
import type { TrimEdge } from '../../store/ui';
import { edgeAt, editTimes, nudgeTime, planEditStep, planNudge } from './timeNudge';

const FPS = 30;
const track = (id: string, locked = false): Track => ({ id, kind: id.startsWith('a') ? 'audio' : 'video', name: id, muted: false, hidden: false, locked });
const image = (trackId: string, id: string, start: number, duration: number, o: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const audio = (trackId: string, id: string, start: number, duration: number, o: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud', trimStart: 0, speed: 1, volume: 1, muted: false, ...o,
});
const fx = (trackId: string, id: string, target: string | null, start: number, duration: number): EffectClip => ({
  id, type: 'effect', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, effect: 'shake', params: {}, amount: 1, seed: 1, target,
});

const TRACKS = ['v1', 'v2', 'v3', 'a1', 'a2'];
function proj(clips: Clip[], locked: string[] = []): Project {
  return { ...createProject('nudge'), fps: FPS, tracks: TRACKS.map((t) => track(t, locked.includes(t))), clips };
}
const f = (n: number) => n / FPS;

describe('nudgeTime', () => {
  it('nudgeTime on and off the grid', () => {
    expect(nudgeTime(1, 1, FPS)).toBeCloseTo(1 + f(1), 12);
    expect(nudgeTime(f(7), -3, FPS)).toBe(f(4));
    expect(nudgeTime(0.51, 1, FPS)).toBeCloseTo(0.51 + f(1), 12);
    expect(nudgeTime(f(1), -1, FPS)).toBe(0);
    expect(nudgeTime(0, -1, FPS)).toBeLessThan(0);
  });
});

describe('planNudge', () => {
  it('followers come along', () => {
    const p = proj([image('v1', 'a', 1, 2), fx('v3', 'e', 'a', 1, 2)]);
    const plan = planNudge(p, ['a'], 3);
    expect(plan.stop).toBeNull();
    expect(plan.ids).toEqual(['a']);
    expect(plan.moves.map((m) => m.id)).toEqual(['a', 'e']);
    expect(plan.moves[1]!.start).toBeCloseTo(1 + f(3), 9);
    expect(moveClipsIn(p, plan.moves)).not.toBeNull();
  });

  it('a follower without room stays', () => {
    const p = proj([image('v1', 'a', 1, 2), fx('v3', 'e', 'a', 1, 2), image('v3', 'w', 3.05, 1)]);
    const plan = planNudge(p, ['a'], 10);
    expect(plan.stop).toBeNull();
    expect(plan.moves.map((m) => m.id)).toEqual(['a']);
    expect(moveClipsIn(p, plan.moves)).not.toBeNull();
  });

  it('a follower stays when the move would overlap, the clips still move', () => {
    // two other clips on the follower's track overlap already, so every plan with the follower in it overlaps
    const p = proj([image('v1', 'a', 1, 2), fx('v3', 'e', 'a', 1, 2), image('v3', 'x', 10, 2), image('v3', 'y', 11, 2)]);
    const plan = planNudge(p, ['a'], 3);
    expect(plan.stop).toBeNull();
    expect(plan.moves.map((m) => m.id)).toEqual(['a']);
    expect(plan.ids).toEqual(['a']);
    expect(moveClipsIn(p, plan.moves)).not.toBeNull();
  });

  it('a locked group mate stays and is named', () => {
    const p = proj([image('v1', 'a', 1, 2, { group: 'g' }), audio('a2', 'b', 1, 2, { group: 'g' })], ['a2']);
    const plan = planNudge(p, ['a'], 1);
    expect(plan.stop).toBeNull();
    expect(plan.ids).toEqual(['a']);
    expect(plan.lockedStay).toEqual(['a2']);
  });

  it('only locked clips: stop locked', () => {
    const p = proj([audio('a2', 'b', 1, 2), image('v1', 'a', 5, 1)], ['a2']);
    const plan = planNudge(p, ['b'], 1);
    expect(plan.stop).toEqual({ why: 'locked', clipId: 'b' });
    expect(plan.moves).toEqual([]);
    expect(plan.lockedStay).toEqual(['a2']);
  });

  it('nothing selected or no frames: an empty plan without a stop', () => {
    const p = proj([image('v1', 'a', 1, 2)]);
    expect(planNudge(p, [], 1)).toMatchObject({ moves: [], stop: null });
    expect(planNudge(p, ['a'], 0)).toMatchObject({ moves: [], stop: null });
  });

  it('timeline-start', () => {
    const p = proj([image('v1', 'a', f(2), 2), image('v2', 'b', 5, 1)]);
    expect(planNudge(p, ['a', 'b'], -3).stop).toEqual({ why: 'timeline-start', clipId: 'a' });
    expect(planNudge(p, ['a', 'b'], -2).stop).toBeNull();
  });

  it('overlap', () => {
    const p = proj([image('v1', 'a', 0, 2), image('v1', 'b', 2.5, 2)]);
    expect(planNudge(p, ['a'], 20).stop).toEqual({ why: 'overlap', clipId: 'a', otherId: 'b' });
    expect(planNudge(p, ['a'], 15).stop).toBeNull();
    // both move together: no overlap
    expect(planNudge(p, ['a', 'b'], 20).stop).toBeNull();
  });

  it('a pre existing overlap on a moving track stops it', () => {
    const p = proj([image('v1', 'a', 0, 2), image('v1', 'b', 1, 2), image('v2', 'c', 5, 1)]);
    const plan = planNudge(p, ['c', 'a'], 1);
    expect(plan.stop?.why).toBe('overlap');
    // a track that does not move is not looked at
    expect(planNudge(p, ['c'], 1).stop).toBeNull();
  });
});

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 40 clips on 5 tracks (a2 locked): images and videos, audio, followers on v3, groups across tracks. no overlaps */
function randomProject(r: () => number): Project {
  const clips: Clip[] = [];
  const pick = (n: number) => Math.floor(r() * n);
  const lay = (trackId: string, count: number, make: (id: string, start: number, dur: number) => Clip): Clip[] => {
    const out: Clip[] = [];
    let t = pick(4) * f(1);
    for (let i = 0; i < count; i++) {
      const dur = f(3 + pick(40)) + (r() < 0.2 ? 0.0123 : 0);
      out.push(make(trackId + '-' + i, t, dur));
      t += dur + (r() < 0.4 ? 0 : f(pick(30)));
    }
    return out;
  };
  clips.push(...lay('v1', 9, (id, s, d) => (r() < 0.5 ? image('v1', id, s, d) : video('v1', id, s, d))));
  clips.push(...lay('v2', 8, (id, s, d) => image('v2', id, s, d)));
  clips.push(...lay('a1', 7, (id, s, d) => audio('a1', id, s, d)));
  clips.push(...lay('a2', 6, (id, s, d) => audio('a2', id, s, d)));
  const v1 = clips.filter((c) => c.trackId === 'v1');
  for (let i = 0; i < 10; i++) {
    const t = v1[i % v1.length]!;
    if (r() < 0.7 && !clips.some((c) => c.type === 'effect' && c.target === t.id)) clips.push(fx('v3', 'fx-' + i, t.id, t.start, t.duration));
  }
  while (clips.length < 40) clips.push(image('v3', 'x' + clips.length, 60 + clips.length * 2, 1));
  // groups of two or three across tracks
  const base = clips.filter((c) => c.type !== 'effect');
  for (let g = 0; g < 5; g++) {
    for (let k = 0; k < 2 + pick(2); k++) base[pick(base.length)]!.group = 'g' + g;
  }
  return { ...createProject('sweep'), fps: FPS, tracks: TRACKS.map((t) => track(t, t === 'a2')), clips };
}

describe('planNudge sweep', () => {
  it('sweep: a plan moves exactly when moveClips would', () => {
    const r = rng(20240611);
    const locked = new Set(['a2']);
    let moved = 0;
    let stopped = 0;
    for (let i = 0; i < 500; i++) {
      const p = randomProject(r);
      const free = p.clips.filter((c) => !locked.has(c.trackId));
      const sel = new Set<string>([free[Math.floor(r() * free.length)]!.id]);
      const extra = Math.floor(r() * 8);
      for (let k = 0; k < extra; k++) sel.add(p.clips[Math.floor(r() * p.clips.length)]!.id);
      const frames = (r() < 0.5 ? -1 : 1) * (r() < 0.5 ? 1 + Math.floor(r() * 3) : 10 + Math.floor(r() * 30));
      const plan = planNudge(p, [...sel], frames);
      const base: ClipMove[] = p.clips.filter((c) => sel.has(c.id) && !locked.has(c.trackId)).map((c) => ({ id: c.id, trackId: c.trackId, start: nudgeTime(c.start, frames, FPS) }));
      const want = moveClipsIn(p, base);
      expect(plan.stop === null, `case ${i}: ${JSON.stringify(plan.stop)}`).toBe(want !== null);
      if (plan.stop) { stopped++; expect(plan.moves).toEqual([]); continue; }
      const next = moveClipsIn(p, plan.moves);
      expect(next, `case ${i}`).not.toBeNull();
      for (const id of plan.ids) {
        const was = p.clips.find((c) => c.id === id)!;
        expect(next!.clips.find((c) => c.id === id)!.start, `case ${i} ${id}`).toBeCloseTo(was.start + frames / FPS, 6);
      }
      moved++;
    }
    expect(moved).toBeGreaterThan(100);
    expect(stopped).toBeGreaterThan(30);
  });

  it('300 clips with 100 selected plan fast', () => {
    const clips: Clip[] = [];
    for (let i = 0; i < 300; i++) clips.push(image(TRACKS[i % 3]!, 'c' + i, Math.floor(i / 3) * 2, 1.5));
    const p = proj(clips);
    const sel = clips.filter((_, i) => i % 3 === 0).slice(0, 100).map((c) => c.id);
    planNudge(p, sel, 1);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) planNudge(p, sel, 1);
    expect((performance.now() - t0) / 20).toBeLessThan(2);
  });
});

describe('editTimes', () => {
  it('editTimes: sorted starts and ends, near duplicates dropped', () => {
    const clips = [image('v1', 'a', 0, 2), image('v1', 'b', 2, 1), image('v2', 'c', 2 + 1e-8, 3), audio('a1', 'd', 1, 1), audio('a1', 'f', 4, 1)];
    expect(editTimes(clips)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(editTimes([])).toEqual([]);
  });
});

const edge = (clipId: string, e: 'start' | 'end' = 'end', both = false, alone = false): TrimEdge => ({ clipId, edge: e, both, alone });

describe('planEditStep', () => {
  const p = proj([image('v1', 'a', 1, 2), image('v1', 'b', 3, 2), image('v2', 'c', 0, 1), image('v2', 'd', 6, 1), audio('a1', 'e', 2, 4)]);

  it('planEditStep all: every track, both ways, null at the ends', () => {
    expect(planEditStep(p, [], null, 0, 1)).toEqual({ scope: 'all', time: 1, edge: null });
    expect(planEditStep(p, [], null, 1, 1).time).toBe(2);
    expect(planEditStep(p, [], null, 6.5, -1).time).toBe(6);
    expect(planEditStep(p, [], null, 3, -1).time).toBe(2);
    expect(planEditStep(p, [], null, 7, 1).time).toBeNull();
    expect(planEditStep(p, [], null, 0, -1).time).toBeNull();
    // 0 is an edit only when a clip starts there
    expect(planEditStep(p, [], null, 1, -1).time).toBe(0);
    const late = proj([image('v1', 'a', 1, 2)]);
    expect(planEditStep(late, [], null, 2, -1).time).toBe(1);
    expect(planEditStep(late, [], null, 1, -1).time).toBeNull();
  });

  it('planEditStep selection: the tracks of the selected clips', () => {
    expect(planEditStep(p, ['a'], null, 0, 1)).toEqual({ scope: 'selection', time: 1, edge: null });
    expect(planEditStep(p, ['a'], null, 3, 1).time).toBe(5);
    expect(planEditStep(p, ['a'], null, 5, 1).time).toBeNull();
    expect(planEditStep(p, ['c'], null, 1, 1).time).toBe(6);
    expect(planEditStep(p, ['a'], null, 1.5, -1).time).toBe(1);
    expect(planEditStep(p, ['gone'], null, 0, 1).scope).toBe('all');
  });

  it('planEditStep selection: followers and locked tracks count', () => {
    const q = proj([image('v1', 'a', 1, 2), fx('v3', 'e', 'a', 1, 2), audio('a2', 'l', 5, 1)], ['a2']);
    expect(planEditStep(q, ['e'], null, 0, 1).time).toBe(1);
    expect(planEditStep(q, ['l'], null, 0, 1)).toEqual({ scope: 'selection', time: 5, edge: null });
  });

  it('planEditStep edge: its own track, from the edge time, not the playhead', () => {
    const st = planEditStep(p, ['a'], edge('a'), 99, 1);
    expect(st.scope).toBe('edge');
    expect(st.time).toBe(5);
    expect(st.edge).toEqual({ clipId: 'b', edge: 'end', both: false, alone: false });
    expect(planEditStep(p, ['a'], edge('a'), 0, -1).time).toBe(1);
    expect(planEditStep(p, ['a'], edge('a', 'start'), 0, -1).time).toBeNull();
    expect(planEditStep(p, ['a'], edge('a', 'start'), 0, -1).edge).toBeNull();
    expect(planEditStep(p, ['a'], edge('b'), 0, 1).time).toBeNull();
  });

  it('planEditStep: a gone edge counts as none, followers are not edits of the edge track', () => {
    expect(planEditStep(p, [], edge('nope'), 0, 1)).toEqual({ scope: 'all', time: 1, edge: null });
    const q = proj([image('v1', 'a', 1, 2), fx('v1', 'e', 'a', 1.5, 0.25), image('v1', 'b', 4, 1)]);
    expect(planEditStep(q, ['a'], edge('a'), 0, 1).time).toBe(4);
  });
});

describe('edgeAt', () => {
  const p = proj([image('v1', 'a', 0, 2), image('v1', 'b', 2, 2), image('v1', 'c', 6, 1), fx('v1', 'e', 'b', 4, 1)]);

  it('edgeAt: both on a touching pair, else by the kind', () => {
    expect(edgeAt(p, 'v1', 2, edge('x', 'end', true, true))).toEqual({ clipId: 'a', edge: 'end', both: true, alone: true });
    expect(edgeAt(p, 'v1', 2, edge('x', 'end'))).toEqual({ clipId: 'a', edge: 'end', both: false, alone: false });
    expect(edgeAt(p, 'v1', 2, edge('x', 'start'))).toEqual({ clipId: 'b', edge: 'start', both: false, alone: false });
    expect(edgeAt(p, 'v1', 0, edge('x', 'end'))).toEqual({ clipId: 'a', edge: 'start', both: false, alone: false });
  });

  it('edgeAt: nothing there is null, followers never count', () => {
    expect(edgeAt(p, 'v1', 5, edge('x'))).toBeNull();
    expect(edgeAt(p, 'v1', 4, edge('x', 'start'))).toEqual({ clipId: 'b', edge: 'end', both: false, alone: false });
    expect(edgeAt(p, 'v2', 2, edge('x'))).toBeNull();
  });

  it('like across a free end', () => {
    // a start kind at a free end (no clip starts there) takes the clip ending there
    expect(edgeAt(p, 'v1', 4, edge('x', 'start'))?.edge).toBe('end');
    // an end kind at a lone start takes that start
    expect(edgeAt(p, 'v1', 6, edge('x', 'end'))).toEqual({ clipId: 'c', edge: 'start', both: false, alone: false });
    // both without a pair is a single edge
    expect(edgeAt(p, 'v1', 7, edge('x', 'end', true))).toEqual({ clipId: 'c', edge: 'end', both: false, alone: false });
  });
});
