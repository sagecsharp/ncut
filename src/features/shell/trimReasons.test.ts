import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, Track, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { TRIM_STOP_TEXT, TRIM_TEXT, lockedTracksText, trimStopText } from '../timeline/trimText';
import type { TrimStopWhy } from '../timeline/trimModes';
import { interaction } from '../timeline/view';
import { paletteActions } from './paletteActions';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import type { ReasonInput } from './reasons';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;
const T = REASON_TEXT;

const track = (id: string, locked = false): Track => ({ id, kind: id.startsWith('a') ? 'audio' : 'video', name: 'track ' + id, muted: false, hidden: false, locked });
const asset = (id: string, duration: number): MediaAsset => ({ id, name: id, kind: 'video', mime: 'video/x', size: 1, duration, width: 100, height: 100, hasAudio: true, createdAt: 0 });
const video = (trackId: string, id: string, start: number, duration: number, o: Partial<VideoClip> = {}): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM }, ...o,
});
const audio = (trackId: string, id: string, start: number, duration: number): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'long', trimStart: 0, speed: 1, volume: 1, muted: false,
});
const image = (trackId: string, id: string, start: number, duration: number): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'pic', transform: { ...DEFAULT_TRANSFORM },
});

interface Setup { clips?: Clip[]; select?: string[]; time?: number; locked?: string[] }

/** v1: a (0..4, media from 2) and b (4..8, media from 0) touching. v2: i (3..5) a picture, x (8..10). a1: au (0..8) */
const CLIPS = (): Clip[] => [
  video('v1', 'a', 0, 4, { trimStart: 2 }), video('v1', 'b', 4, 4),
  image('v2', 'i', 3, 2), video('v2', 'x', 8, 2),
  audio('a1', 'au', 0, 8),
];

function open(s: Setup = {}): void {
  const p: Project = {
    ...createProject('reasons'),
    tracks: ['v1', 'v2', 'a1'].map((t) => track(t, s.locked?.includes(t))),
    assets: [asset('long', 100), { ...asset('pic', 0), kind: 'image' }],
    clips: s.clips ?? CLIPS(),
  };
  useEditor.setState({ project: p, past: [], future: [], selection: s.select ?? [], clipboard: [] });
  usePlayback.setState({ time: s.time ?? 0 });
}

const input = (over: Partial<ReasonInput> = {}): ReasonInput => ({ ...reasonSnapshot(), ...over });
const edgeOf = (clipId: string, edge: 'start' | 'end' = 'end', both = false, alone = false): TrimEdge => ({ clipId, edge, both, alone });
const action = (id: string) => paletteActions().find((a) => a.id === id)!;

beforeEach(() => {
  useEditor.setState({ project: null, past: [], future: [], selection: [], clipboard: [] });
  useUi.setState({ toasts: [], trimMode: false, trimEdge: null });
  usePlayback.setState({ time: 0 });
  interaction.gestureActive = false;
});

const NEW_IDS = ['ripple-start', 'ripple-end', 'edit-select', 'edge-prev', 'edge-next', 'slip-earlier', 'slip-later', 'slide-left', 'slide-right'];

describe('trim reasons', () => {
  it('each new reason in a typical state', () => {
    // ripple trim to the playhead
    open({ clips: [], time: 1 });
    expect(reasonFor('ripple-start', input())).toBe(T.addClip);
    expect(reasonFor('ripple-end', input())).toBe(T.addClip);
    open({ time: 20 });
    expect(reasonFor('ripple-start', input())).toBe(T.noClipUnder);
    expect(reasonFor('ripple-end', input({ selection: ['a'] }))).toBe(T.playheadOnClip);
    open({ time: 2 });
    expect(reasonFor('ripple-start', input())).toBeNull();
    expect(reasonFor('ripple-end', input({ selection: ['a'] }))).toBeNull();
    // a head with a clip on another track 0.5 after its start: the start edge stops at 3.5
    open({ clips: [video('v1', 'h', 3, 5), video('v2', 'm', 3.5, 1.5)], time: 7 });
    expect(reasonFor('ripple-start', input())).toBe(trimStopText({ why: 'timeline-start', clipId: 'm' }, proj()));
    // edit-select
    open({ time: 2 });
    expect(reasonFor('edit-select', input())).toBe(T.noEdgeHere);
    open({ time: 4 });
    expect(reasonFor('edit-select', input())).toBeNull();
    // edge rows without an edge seek, the key rows keep their old reasons
    expect(reasonFor('edge-prev', input())).toBeNull();
    expect(reasonFor('edge-next', input())).toBeNull();
    expect(reasonFor('key-prev', input())).toBe(T.selectClip);
    // edge rows with an edge
    expect(reasonFor('edge-next', input({ trimEdge: edgeOf('a') }))).toBeNull();
    expect(reasonFor('key-next', input({ trimEdge: edgeOf('a', 'end', true) }))).toBeNull();
    // b has no media before its first frame: the edit cannot go left
    expect(reasonFor('key-prev', input({ trimEdge: edgeOf('a', 'end', true) }))).toBe(trimStopText({ why: 'media-start', clipId: 'b' }, proj()));
    expect(reasonFor('edge-next', input({ trimEdge: edgeOf('gone') }))).toBe(T.pickEdge);
    expect(reasonFor('key-next', input({ trimEdge: edgeOf('gone') }))).toBe(T.pickEdge);
    expect(reasonFor('edge-next', input({ trimEdge: edgeOf('b', 'end', true) }))).toBe(trimStopText({ why: 'no-edit', clipId: 'b' }, proj()));
    // the end of a would cross into b
    open({ clips: [video('v1', 'a', 0, 4), video('v1', 'n', 4.01, 2)] });
    expect(reasonFor('edge-next', input({ trimEdge: edgeOf('a'), selection: ['a'] }))).toBeNull();
    expect(reasonFor('key-next', input({ trimEdge: edgeOf('a', 'start'), selection: ['a'] }))).toBeNull();
    open({ clips: [video('v1', 'a', 0, 0.06)] });
    expect(reasonFor('key-prev', input({ trimEdge: edgeOf('a') }))).toBe(trimStopText({ why: 'min-length', clipId: 'a' }, proj()));
    // slip and slide
    open({ select: [] });
    expect(reasonFor('slip-earlier', input())).toBe(T.timedFirst);
    expect(reasonFor('slide-left', input())).toBe(T.selectClip);
    expect(reasonFor('slip-later', input({ selection: ['i'] }))).toBe(T.timedFirst);
    expect(reasonFor('slip-earlier', input({ selection: ['b'] }))).toBe(trimStopText({ why: 'media-start', clipId: 'b' }, proj()));
    expect(reasonFor('slip-earlier', input({ selection: ['a'] }))).toBeNull();
    expect(reasonFor('slip-later', input({ selection: ['b'] }))).toBeNull();
    expect(reasonFor('slide-right', input({ selection: ['b'] }))).toBeNull();
    open({ clips: [video('v1', 'c', 0, 4), video('v1', 'n', 4.01, 2)] });
    expect(reasonFor('slide-right', input({ selection: ['c'] }))).toBe(trimStopText({ why: 'overlap', clipId: 'c', otherId: 'n' }, proj()));
    expect(reasonFor('slide-left', input({ selection: ['c'] }))).toBe(trimStopText({ why: 'timeline-start', clipId: 'c' }, proj()));
  });

  it('every new id has a reason and a search row', () => {
    for (const id of [...NEW_IDS, 'key-prev', 'key-next']) {
      expect(REASON_IDS.has(id), id).toBe(true);
      expect(action(id), id).toBeDefined();
    }
  });

  it('a reason means the action changes nothing', () => {
    const states: Setup[] = [
      { clips: [] },
      { time: 20 },
      { time: 20, select: ['a'] },
      { time: 2, select: ['a'] },
      { time: 4 },
      { time: 4, select: ['a', 'b'] },
      { time: 2, select: ['i'] },
      { time: 2, select: ['au'] },
      { time: 6, select: ['b'] },
      { time: 2, select: ['a'], locked: ['v1'] },
      { time: 7, select: ['h'], clips: [video('v1', 'h', 3, 5), video('v2', 'm', 3.5, 1.5)] },
      { time: 4, select: ['c'], clips: [video('v1', 'c', 0, 4), video('v1', 'n', 4.01, 2)] },
      { time: 1, select: ['a'], clips: [video('v1', 'a', 0, 0.06)] },
    ];
    // the picked edge: none, one that works, one at an edit, one whose clip is gone
    const edges: (TrimEdge | null)[] = [null, edgeOf('a'), edgeOf('a', 'start'), edgeOf('a', 'end', true), edgeOf('b', 'end', true), edgeOf('c'), edgeOf('gone')];
    // what a row must leave alone: the project, the selection and the playhead (a gone edge is cleared, that is its answer)
    const snap = () => JSON.stringify({ project: proj(), selection: ed().selection, time: usePlayback.getState().time });
    let checked = 0;
    for (const id of [...NEW_IDS, 'key-prev', 'key-next']) {
      for (const s of states) {
        for (const edge of edges) {
          open(s);
          useUi.setState({ trimEdge: edge, trimMode: edge !== null });
          const why = reasonFor(id, reasonSnapshot());
          if (!why) continue;
          const before = snap();
          action(id).run();
          expect(snap(), `${id} in ${JSON.stringify(s)} edge ${JSON.stringify(edge)}: ${why}`).toBe(before);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(60);
  });

  it('a gone edge answers pickEdge on the edge rows and the row clears it', () => {
    open({ time: 2 });
    useUi.setState({ trimEdge: edgeOf('gone'), trimMode: true });
    for (const id of ['edge-prev', 'edge-next', 'key-prev', 'key-next']) expect(reasonFor(id, reasonSnapshot()), id).toBe(T.pickEdge);
    const before = JSON.stringify(proj());
    action('edge-next').run();
    expect(JSON.stringify(proj())).toBe(before);
    expect(useUi.getState().trimEdge).toBeNull();
    expect(useUi.getState().toasts.map((t) => t.message)).toEqual([T.pickEdge]);
  });

  it('stop and locked texts name clips and tracks', () => {
    open({ clips: [video('v1', 'a', 0, 4), video('v1', 'b', 4, 4)], locked: ['v2', 'a1'] });
    const p = proj();
    const whys = Object.keys(TRIM_STOP_TEXT) as TrimStopWhy[];
    for (const why of whys) {
      const text = trimStopText({ why, clipId: 'a', otherId: 'b' }, p);
      expect(text, why).not.toMatch(/\{|\}/);
      if (TRIM_STOP_TEXT[why].includes('{clip}')) expect(text, why).toContain('"a"');
      if (TRIM_STOP_TEXT[why].includes('{other}')) expect(text, why).toContain('"b"');
    }
    expect(trimStopText({ why: 'overlap', clipId: 'a', otherId: 'b' }, p)).toBe('"a" would run into "b"');
    expect(trimStopText({ why: 'locked', clipId: 'gone' }, p)).toBe('a clip is on a locked track');
    expect(lockedTracksText(p, ['v2', 'a1'])).toBe('track v2, track a1');
    expect(TRIM_TEXT.lockedStay.replace('{tracks}', lockedTracksText(p, ['v2']))).toBe('locked tracks did not move: track v2');
  });
});
