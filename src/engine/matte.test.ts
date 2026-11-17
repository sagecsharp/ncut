import { describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ClipMatte, MatteMode, Project, Track, VisualClip } from '../types';
import { createProject, createShapeClip } from '../lib/factory';
import { EFFECTS } from './effects/registry';
import {
  MATTE_LUMA_DEF,
  MATTE_LUMA_PASS,
  MATTE_MODES,
  MATTE_MODE_LABELS,
  MATTE_MODE_WORDS,
  MATTE_TEXT,
  isInverted,
  isMatteMode,
  matteField,
  matteHint,
  matteHoverIds,
  matteLinkedIds,
  matteOf,
  matteProblem,
  matteSelectIds,
  matteSourceSet,
  matteState,
  matteTable,
  matteUserIds,
  matteUsersMap,
  planMatteAbove,
  planMatteMode,
  planMatteRelease,
  planMatteRemove,
  planMatteSet,
  selectedMattesAt,
  type MatteState,
} from './matte';

const track = (id: string, kind: 'video' | 'audio' = 'video', over: Partial<Track> = {}): Track => ({ id, kind, name: id, muted: false, hidden: false, locked: false, ...over });
/** tracks listed top first: index 0 is drawn on top */
const clip = (id: string, trackId: string, start: number, duration: number, over: Partial<VisualClip> = {}): VisualClip =>
  createShapeClip(trackId, start, { id, name: id, duration, ...over } as Partial<VisualClip> as never);
const audio = (id: string, trackId: string): AudioClip => ({ id, type: 'audio', trackId, start: 0, duration: 10, name: id, fadeIn: 0, fadeOut: 0, assetId: 'a', trimStart: 0, speed: 1, volume: 1, muted: false });
const project = (tracks: Track[], clips: Clip[]): Project => ({ ...createProject(), tracks, clips });
const m = (clipId: string, mode: MatteMode = 'alpha'): ClipMatte => ({ clip: clipId, mode });
const T3 = (): Track[] => [track('v1'), track('v2'), track('v3'), track('a1', 'audio')];

describe('fields and modes', () => {
  it('matteField keeps a well formed field only', () => {
    expect(matteField(clip('a', 'v2', 0, 5, { matte: m('b', 'luma') }))).toEqual(m('b', 'luma'));
    expect(matteField(clip('a', 'v2', 0, 5))).toBeNull();
    expect(matteField(clip('a', 'v2', 0, 5, { matte: null }))).toBeNull();
    expect(matteField(clip('a', 'v2', 0, 5, { matte: { clip: '', mode: 'alpha' } }))).toBeNull();
    expect(matteField(clip('a', 'v2', 0, 5, { matte: { clip: 'b', mode: 'bad' as MatteMode } }))).toBeNull();
    expect(matteField(clip('a', 'v2', 0, 5, { matte: { clip: 4, mode: 'alpha' } as unknown as ClipMatte }))).toBeNull();
    expect(matteField(audio('s', 'a1'))).toBeNull();
    expect(matteField(null)).toBeNull();
    expect(matteField(undefined)).toBeNull();
  });
  it('the four modes have labels, words and an inverted flag', () => {
    expect(MATTE_MODES).toEqual(['alpha', 'alpha-inv', 'luma', 'luma-inv']);
    for (const mode of MATTE_MODES) {
      expect(isMatteMode(mode)).toBe(true);
      expect(MATTE_MODE_LABELS[mode].length).toBeGreaterThan(0);
      expect(MATTE_MODE_WORDS[mode].length).toBeGreaterThan(0);
    }
    expect(isMatteMode('beta')).toBe(false);
    expect(isMatteMode(3)).toBe(false);
    expect(MATTE_MODES.filter(isInverted)).toEqual(['alpha-inv', 'luma-inv']);
  });
});

describe('matteTable', () => {
  it('is null without a field, twice, and for a field that does not count', () => {
    const p = project(T3(), [clip('a', 'v2', 0, 5), clip('b', 'v1', 0, 5)]);
    expect(matteTable(p)).toBeNull();
    expect(matteTable(p)).toBeNull();
    expect(matteSourceSet(p).size).toBe(0);
    expect(matteSourceSet(p)).toBe(matteSourceSet(project(T3(), [])));
    expect(matteOf(p, 'a')).toBeNull();
    const gone = project(T3(), [clip('a', 'v2', 0, 5, { matte: m('nope') })]);
    expect(matteTable(gone)).toBeNull();
  });
  it('a counting matte is in byClip, sources and sourceClips once', () => {
    const src = clip('m', 'v1', 0, 5);
    const p = project(T3(), [clip('a', 'v2', 0, 5, { matte: m('m', 'luma') }), clip('b', 'v3', 0, 5, { matte: m('m') }), src]);
    const t = matteTable(p)!;
    expect(t.byClip.size).toBe(2);
    expect(t.byClip.get('a')).toEqual({ src, mode: 'luma' });
    expect(t.byClip.get('b')!.mode).toBe('alpha');
    expect([...t.sources]).toEqual(['m']);
    expect(t.sourceClips).toEqual([src]);
    expect(matteOf(p, 'a')!.src).toBe(src);
    expect(matteOf(p, 'm')).toBeNull();
    expect(matteTable(p)).toBe(t);
  });
  it('does not count itself, a missing clip, a clip that is no picture or a matte clip with a matte', () => {
    const cases: Clip[][] = [
      [clip('a', 'v2', 0, 5, { matte: m('a') })],
      [clip('a', 'v2', 0, 5, { matte: m('x') })],
      [clip('a', 'v2', 0, 5, { matte: m('s') }), audio('s', 'a1')],
    ];
    for (const clips of cases) expect(matteTable(project(T3(), clips))).toBeNull();
    // a matte clip with a matte of its own: the first matte does not count, the second does
    const chain = matteTable(project(T3(), [clip('a', 'v2', 0, 5, { matte: m('b') }), clip('b', 'v1', 0, 5, { matte: m('c') }), clip('c', 'v3', 0, 5)]))!;
    expect([...chain.byClip.keys()]).toEqual(['b']);
  });
  it('two clips naming each other count on neither', () => {
    const p = project(T3(), [clip('a', 'v2', 0, 5, { matte: m('b') }), clip('b', 'v1', 0, 5, { matte: m('a') })]);
    expect(matteTable(p)).toBeNull();
  });
  it('does not count a matte clip on a hidden track', () => {
    const tracks = [track('v1', 'video', { hidden: true }), track('v2')];
    const p = project(tracks, [clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v1', 0, 5)]);
    expect(matteTable(p)).toBeNull();
  });
  it('does not count a clip that is shown on a side of a solid', () => {
    const solid = clip('solid', 'v1', 0, 5, { threeD: true, shape: 'box', faces: { front: { clip: 'a' } } });
    const p = project(T3(), [solid, clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v3', 0, 5)]);
    expect(matteTable(p)).toBeNull();
  });
  it('rebuilds on new clips, new tracks or a new count', () => {
    const clips: Clip[] = [clip('a', 'v2', 0, 5, { matte: m('m') })];
    const p = project(T3(), clips);
    expect(matteTable(p)).toBeNull();
    clips.push(clip('m', 'v1', 0, 5));
    expect(matteTable(p)!.byClip.size).toBe(1);
    p.tracks = [track('v1', 'video', { hidden: true }), track('v2'), track('v3'), track('a1', 'audio')];
    expect(matteTable(p)).toBeNull();
    p.clips = [...p.clips, clip('b', 'v3', 0, 5, { matte: m('m') })];
    p.tracks = T3();
    expect(matteTable(p)!.byClip.size).toBe(2);
  });
});

describe('problems and states', () => {
  const p = project(T3(), [
    clip('a', 'v2', 0, 5),
    clip('b', 'v1', 0, 5),
    clip('hasMatte', 'v3', 0, 5, { matte: m('b') }),
    audio('s', 'a1'),
  ]);
  it('matteProblem answers in order', () => {
    expect(matteProblem(p.clips, 'nope', 'b')).toBe(MATTE_TEXT.notPicture);
    expect(matteProblem(p.clips, 's', 'b')).toBe(MATTE_TEXT.notPicture);
    expect(matteProblem(p.clips, 'a', 'a')).toBe(MATTE_TEXT.self);
    expect(matteProblem(p.clips, 'a', 'zzz')).toBe(MATTE_TEXT.gone);
    expect(matteProblem(p.clips, 'a', 's')).toBe(MATTE_TEXT.srcNotPicture);
    expect(matteProblem(p.clips, 'a', 'hasMatte')).toBe(MATTE_TEXT.srcHasMatte);
    // b is the matte of hasMatte: it cannot have one
    expect(matteProblem(p.clips, 'b', 'a')).toBe(MATTE_TEXT.isMatte);
    expect(matteProblem(p.clips, 'a', 'b')).toBeNull();
  });
  it('the words never say track matte, link, parent or source', () => {
    for (const text of Object.values(MATTE_TEXT)) expect(text).not.toMatch(/track matte|\blink|\bparent|\bsource/);
  });
  it('matteUsersMap lists the users, counting or not, cached per array', () => {
    const map = matteUsersMap(p.clips);
    expect(map.get('b')).toEqual(['hasMatte']);
    expect(matteUsersMap(p.clips)).toBe(map);
    expect(matteUserIds(p.clips, 'b')).toEqual(['hasMatte']);
    expect(matteUserIds(p.clips, 'a')).toEqual([]);
    expect(matteUserIds(p.clips, 'a')).toBe(matteUserIds(p.clips, 'zzz'));
    const more = [...p.clips];
    expect(matteUsersMap(more)).not.toBe(map);
  });
  it('matteState says what a matte does now', () => {
    const states = (clips: Clip[], tracks = T3()): MatteState => matteState(project(tracks, clips), 'a');
    expect(states([clip('a', 'v2', 0, 5), clip('m', 'v1', 0, 5)])).toBe('none');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v1', 3, 5)])).toBe('on');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v1', 5, 5)])).toBe('apart');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('zz') })])).toBe('gone');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('a') })])).toBe('gone');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('s') }), audio('s', 'a1')])).toBe('not-picture');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('b') }), clip('b', 'v1', 0, 5, { matte: m('c') }), clip('c', 'v3', 0, 5)])).toBe('chain');
    expect(states([clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v1', 0, 5)], [track('v1', 'video', { hidden: true }), track('v2')])).toBe('hidden-track');
    const solid = clip('solid', 'v1', 0, 5, { threeD: true, shape: 'box', faces: { front: { clip: 'a' } } });
    expect(states([solid, clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v3', 0, 5)])).toBe('on-sides');
    expect(matteState(project(T3(), []), 'nope')).toBe('none');
  });
  it('matteHint gives a line per state and mode, and the 3d line', () => {
    const states: MatteState[] = ['none', 'on', 'apart', 'gone', 'not-picture', 'chain', 'hidden-track', 'on-sides'];
    for (const s of states) for (const mode of MATTE_MODES) expect(matteHint(s, mode, 'sky', false).length).toBeGreaterThan(10);
    expect(matteHint('on', 'alpha', 'sky', false)).toBe('shows only inside sky. where sky does not play, this clip is hidden');
    expect(matteHint('on', 'alpha-inv', 'sky', false)).toBe('shows only outside sky. where sky does not play, all of this clip shows');
    expect(matteHint('on', 'luma', 'sky', false)).toBe('shows where sky is bright and fades where it is dark. where sky does not play, this clip is hidden');
    expect(matteHint('on', 'luma-inv', 'sky', false)).toBe('shows where sky is dark and fades where it is bright. where sky does not play, all of this clip shows');
    expect(matteHint('on', 'alpha', 'sky', true)).toContain('a 3d clip with a matte is drawn on its own: it does not hide behind other 3d clips');
    expect(matteHint('apart', 'alpha', 'sky', false)).toBe('sky never plays while this clip does: this clip is hidden');
    expect(matteHint('apart', 'luma-inv', 'sky', false)).toBe('sky never plays while this clip does: the matte does nothing');
    expect(matteHint('gone', 'alpha', '', false)).toBe('the matte clip is gone: pick another one or remove the matte');
    expect(matteHint('chain', 'alpha', 'sky', false)).toBe('sky has a matte of its own: a matte clip cannot have one, so this matte is off');
    expect(matteHint('hidden-track', 'alpha', 'sky', false)).toBe('the track of sky is hidden: the matte is off');
    expect(matteHint('on-sides', 'alpha', 'sky', false)).toBe('this clip shows on a side of a solid: a matte does nothing there');
    expect(matteHint('none', 'alpha', '', false)).toBe('pick a clip: this one then shows only through it. the matte clip is not drawn on its own');
    expect(matteHint('not-picture', 'alpha', '', false)).toBe('the matte must be a video, image, text or shape clip: pick another one');
  });
});

describe('planners', () => {
  it('planMatteSet gives picture clips with no problem a matte, in alpha by default', () => {
    const p = project(T3(), [clip('a', 'v2', 0, 5), clip('b', 'v3', 0, 5), clip('m', 'v1', 0, 5), audio('s', 'a1')]);
    expect(planMatteSet(p, ['a', 'b', 's', 'm'], 'm')).toEqual([
      { id: 'a', matte: m('m', 'alpha') },
      { id: 'b', matte: m('m', 'alpha') },
    ]);
    expect(planMatteSet(p, ['a'], 'm', 'luma-inv')).toEqual([{ id: 'a', matte: m('m', 'luma-inv') }]);
    expect(planMatteSet(p, ['a'], 'a')).toEqual([]);
    expect(planMatteSet(p, ['a'], 'zzz')).toEqual([]);
  });
  it('planners skip locked tracks and unchanged clips', () => {
    const tracks = [track('v1'), track('v2', 'video', { locked: true }), track('v3'), track('a1', 'audio')];
    const p = project(tracks, [clip('a', 'v2', 0, 5, { matte: m('m') }), clip('b', 'v3', 0, 5, { matte: m('m', 'luma') }), clip('m', 'v1', 0, 5)]);
    expect(planMatteSet(p, ['a', 'b'], 'm', 'luma')).toEqual([]);
    expect(planMatteMode(p, ['a', 'b'], 'luma')).toEqual([]);
    expect(planMatteMode(p, ['a', 'b'], 'alpha-inv')).toEqual([{ id: 'b', matte: m('m', 'alpha-inv') }]);
    expect(planMatteRemove(p, ['a', 'b', 'm'])).toEqual([{ id: 'b', matte: null }]);
    expect(planMatteRelease(p, 'm')).toEqual([{ id: 'b', matte: null }]);
    expect(planMatteRelease(p, 'b')).toEqual([]);
    expect(planMatteMode(p, ['m'], 'luma')).toEqual([]);
  });
  it('planMatteRemove takes off a stored field even when it is malformed', () => {
    const p = project(T3(), [clip('a', 'v2', 0, 5, { matte: { clip: '', mode: 'alpha' } })]);
    expect(planMatteRemove(p, ['a'])).toEqual([{ id: 'a', matte: null }]);
  });
  it('planMatteAbove takes the nearest track above', () => {
    const p = project(T3(), [clip('a', 'v3', 0, 5), clip('near', 'v2', 0, 5), clip('far', 'v1', 0, 5)]);
    expect(planMatteAbove(p, ['a'])).toEqual({ edits: [{ id: 'a', matte: m('near') }] });
  });
  it('planMatteAbove skips hidden tracks and non video ones, and keeps the mode', () => {
    const tracks = [track('v1'), track('v2', 'video', { hidden: true }), track('v3')];
    const p = project(tracks, [clip('a', 'v3', 0, 5, { matte: m('x', 'luma') }), clip('hid', 'v2', 0, 5), clip('far', 'v1', 0, 5)]);
    expect(planMatteAbove(p, ['a'])).toEqual({ edits: [{ id: 'a', matte: m('far', 'luma') }] });
  });
  it('planMatteAbove prefers the most overlap, then the earlier start', () => {
    const p = project(T3(), [clip('a', 'v3', 0, 10), clip('short', 'v2', 0, 2), clip('long', 'v2', 4, 5)]);
    expect(planMatteAbove(p, ['a'])).toEqual({ edits: [{ id: 'a', matte: m('long') }] });
    const tie = project(T3(), [clip('a', 'v3', 0, 10), clip('late', 'v2', 5, 5), clip('early', 'v2', 0, 5)]);
    expect(planMatteAbove(tie, ['a'])).toEqual({ edits: [{ id: 'a', matte: m('early') }] });
  });
  it('planMatteAbove with two clips: the one on the higher track is the matte', () => {
    const p = project(T3(), [clip('low', 'v3', 0, 5), clip('high', 'v1', 0, 5)]);
    expect(planMatteAbove(p, ['low', 'high'])).toEqual({ edits: [{ id: 'low', matte: m('high') }] });
    expect(planMatteAbove(p, ['high', 'low'])).toEqual({ edits: [{ id: 'low', matte: m('high') }] });
  });
  it('planMatteAbove stops with a reason', () => {
    const p = project(T3(), [clip('a', 'v3', 0, 5), clip('b', 'v3', 6, 2), clip('c', 'v1', 20, 2), clip('d', 'v2', 0, 5, { matte: m('x') }), audio('s', 'a1')]);
    expect(planMatteAbove(p, [])).toEqual({ stop: MATTE_TEXT.pickOneOrTwo });
    expect(planMatteAbove(p, ['s'])).toEqual({ stop: MATTE_TEXT.pickOneOrTwo });
    expect(planMatteAbove(p, ['a', 'b', 'c'])).toEqual({ stop: MATTE_TEXT.pickOneOrTwo });
    expect(planMatteAbove(p, ['a', 'b'])).toEqual({ stop: MATTE_TEXT.sameTrack });
    expect(planMatteAbove(p, ['c'])).toEqual({ stop: MATTE_TEXT.noneAbove });
    // c is the only candidate on v1 but it does not play with b
    expect(planMatteAbove(p, ['b'])).toEqual({ stop: MATTE_TEXT.noneAbove });
    const locked = project([track('v1'), track('v2', 'video', { locked: true })], [clip('a', 'v2', 0, 5), clip('m', 'v1', 0, 5)]);
    expect(planMatteAbove(locked, ['a'])).toEqual({ stop: MATTE_TEXT.trackLocked });
    const chain = project(T3(), [clip('a', 'v3', 0, 5), clip('up', 'v2', 0, 5, { matte: m('top') }), clip('top', 'v1', 0, 5)]);
    // the nearest clip above has a matte of its own: it is no candidate, the next track gives one
    expect(planMatteAbove(chain, ['a'])).toEqual({ edits: [{ id: 'a', matte: m('top') }] });
    const pair = project(T3(), [clip('a', 'v3', 0, 5, { matte: m('x') }), clip('up', 'v1', 0, 5, { matte: m('a') })]);
    expect(planMatteAbove(pair, ['a', 'up'])).toEqual({ stop: MATTE_TEXT.srcHasMatte });
  });
});

describe('selection and links', () => {
  const p = project(T3(), [
    clip('a', 'v2', 0, 10, { matte: m('m') }),
    clip('b', 'v3', 0, 10, { matte: m('m') }),
    clip('m', 'v1', 2, 4),
    clip('other', 'v3', 0, 10),
  ]);
  it('selectedMattesAt gives the selected playing matte clips in project order', () => {
    expect(selectedMattesAt(p, ['m'], 3).map((c) => c.id)).toEqual(['m']);
    expect(selectedMattesAt(p, ['m'], 7)).toEqual([]);
    expect(selectedMattesAt(p, ['m'], 6)).toEqual([]);
    expect(selectedMattesAt(p, ['m'], 2)).toHaveLength(1);
    expect(selectedMattesAt(p, ['a', 'other'], 3)).toEqual([]);
    expect(selectedMattesAt(p, [], 3)).toEqual([]);
    expect(selectedMattesAt(project(T3(), [clip('x', 'v1', 0, 5)]), ['x'], 1)).toEqual([]);
  });
  it('selectedMattesAt skips a matte clip on a locked or hidden track', () => {
    const locked = project([track('v1', 'video', { locked: true }), track('v2')], [clip('a', 'v2', 0, 5, { matte: m('m') }), clip('m', 'v1', 0, 5)]);
    expect(selectedMattesAt(locked, ['m'], 1)).toEqual([]);
  });
  it('matteSelectIds gives the matte clips of the selected and the users of selected matte clips', () => {
    expect(matteSelectIds(p, ['a'])).toEqual(['m']);
    expect(matteSelectIds(p, ['m'])).toEqual(['a', 'b']);
    expect(matteSelectIds(p, ['a', 'm'])).toEqual(['b']);
    expect(matteSelectIds(p, ['other'])).toEqual([]);
    expect(matteSelectIds(p, [])).toEqual([]);
  });
  it('matteLinkedIds and matteHoverIds give the other side of each pair', () => {
    expect([...matteLinkedIds(p.clips, ['a'])]).toEqual(['m']);
    expect([...matteLinkedIds(p.clips, ['m'])].sort()).toEqual(['a', 'b']);
    expect(matteLinkedIds(p.clips, ['other']).size).toBe(0);
    expect(matteLinkedIds(p.clips, []).size).toBe(0);
    expect([...matteHoverIds(p.clips, 'm')].sort()).toEqual(['a', 'b']);
    expect([...matteHoverIds(p.clips, 'b')]).toEqual(['m']);
    expect(matteHoverIds(p.clips, null).size).toBe(0);
  });
});

describe('the luma pass', () => {
  it('is an own alpha def outside the registry', () => {
    expect(MATTE_LUMA_DEF.alpha).toBe('own');
    expect(MATTE_LUMA_DEF.id).toBe('matte-luma');
    expect(MATTE_LUMA_DEF.params).toEqual([]);
    expect(EFFECTS.some((e) => e.id === MATTE_LUMA_DEF.id)).toBe(false);
    expect(MATTE_LUMA_PASS.def).toBe(MATTE_LUMA_DEF);
    expect(MATTE_LUMA_PASS.amount).toBe(1);
    expect(MATTE_LUMA_DEF.glsl).toContain('vec4 effect(vec2 uv)');
  });
});
