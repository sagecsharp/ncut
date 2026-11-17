import { beforeEach, describe, expect, it } from 'vitest';
import type { AudioClip, Clip, ImageClip, MediaAsset, Project, VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import type { TrimEdge } from '../../store/ui';
import { resetNudgeState } from '../timeline/nudgeActions';
import { liveEdge } from '../timeline/timeNudge';
import { trimStopText } from '../timeline/trimText';
import { REASON_IDS, REASON_TEXT, reasonFor, reasonSnapshot } from './reasons';
import type { ReasonInput } from './reasons';
import { SHORTCUTS } from './shortcuts';

const ed = () => useEditor.getState();
const proj = (): Project => ed().project!;

const asset = (id: string, kind: 'image' | 'video' | 'audio' = 'image', duration = 0): MediaAsset => ({
  id, name: id, kind, mime: kind + '/x', size: 1, duration, width: 100, height: 100, hasAudio: kind !== 'image', createdAt: 0,
});
const image = (trackId: string, id: string, start: number, duration: number, over: Partial<ImageClip> = {}): ImageClip => ({
  id, type: 'image', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'img1', transform: { ...DEFAULT_TRANSFORM }, ...over,
});
const video = (trackId: string, id: string, start: number, duration: number): VideoClip => ({
  id, type: 'video', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'vid1', trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
});
const audio = (trackId: string, id: string, start: number, duration: number, over: Partial<AudioClip> = {}): AudioClip => ({
  id, type: 'audio', trackId, start, duration, name: id, fadeIn: 0, fadeOut: 0, assetId: 'aud1', trimStart: 0, speed: 1, volume: 1, muted: false, ...over,
});

interface Setup {
  clips?: boolean;
  select?: string[];
  time?: number;
  lock?: boolean;
  /** a2 touches the end of a on its track */
  touch?: boolean;
  /** a on t0 and au on the locked t3 are one group */
  mate?: boolean;
  edge?: TrimEdge | null;
  source?: boolean;
}

/** t0, t1, t2 video tracks, t3 audio. clips: a (0..2) and b (3..5) images, v (6..8) video, au (0..5) audio. as reasons.test.ts open() */
function open(s: Setup = {}): string[] {
  const p = createProject('reasons');
  ed().openProject({ ...p, assets: [asset('img1'), asset('vid1', 'video', 10), asset('aud1', 'audio', 60)], clips: [] });
  for (let i = 0; i < 3; i++) ed().addTrack('video');
  const t = proj().tracks.map((x) => x.id);
  const g = s.mate ? { group: 'g' } : {};
  const clips: Clip[] = s.clips === false ? [] : [image(t[0]!, 'a', 0, 2, g), image(t[1]!, 'b', 3, 2), video(t[2]!, 'v', 6, 2), audio(t[3]!, 'au', 0, 5, g)];
  if (s.touch && s.clips !== false) clips.push(image(t[0]!, 'a2', 2, 2));
  const tracks = proj().tracks.map((x) => ((s.lock && x.id === t[0]) || (s.mate && x.id === t[3]) ? { ...x, locked: true } : x));
  useEditor.setState({ project: { ...proj(), clips, tracks }, past: [], future: [], selection: s.select ?? [], clipboard: [] });
  usePlayback.setState({ time: s.time ?? 0, playing: false });
  useUi.setState({ trimEdge: s.edge ?? null, previewMode: s.source ? 'source' : 'output' });
  return t;
}

const input = (over: Partial<ReasonInput> = {}): ReasonInput => ({ ...reasonSnapshot(), ...over });

beforeEach(() => {
  useEditor.setState({ project: null, selection: [], past: [], future: [], clipboard: [] });
  usePlayback.setState({ time: 0, playing: false });
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output', trimEdge: null });
  useSource.getState().close();
  resetNudgeState();
});

const NUDGES = ['nudge-left', 'nudge-right', 'nudge-left-big', 'nudge-right-big'];
const EDITS = ['edit-prev', 'edit-next'];
const TIME_IDS = ['go-to-time', ...EDITS, ...NUDGES];

describe('time key reasons', () => {
  it('each new reason in a typical state', () => {
    const T = REASON_TEXT;
    // the source view has the keys: all seven
    open({ select: ['a'], source: true });
    for (const id of TIME_IDS) expect(reasonFor(id, reasonSnapshot()), id).toBe(T.sourceHasKeys);
    // no clips
    open({ clips: false });
    for (const id of TIME_IDS) expect(reasonFor(id, reasonSnapshot()), id).toBe(T.addClip);
    // the six no edit texts
    open({ time: 100 });
    expect(reasonFor('edit-next', input())).toBe(T.noEditAfter);
    open({ time: 0 });
    expect(reasonFor('edit-prev', input())).toBe(T.noEditBefore);
    expect(reasonFor('edit-next', input())).toBeNull();
    open({ time: 100, select: ['a'] });
    expect(reasonFor('edit-next', input())).toBe(T.noEditAfterSel);
    open({ time: 0, select: ['a'] });
    expect(reasonFor('edit-prev', input())).toBe(T.noEditBeforeSel);
    open({ select: ['b'], edge: { clipId: 'b', edge: 'end', both: false, alone: false } });
    expect(reasonFor('edit-next', input())).toBe(T.noEditAfterEdge);
    open({ select: ['b'], edge: { clipId: 'b', edge: 'start', both: false, alone: false } });
    expect(reasonFor('edit-prev', input())).toBe(T.noEditBeforeEdge);
    // nothing selected
    open();
    expect(reasonFor('nudge-right', input())).toBe(T.selectClip);
    // the stop texts
    open({ select: ['a'] });
    expect(reasonFor('nudge-left', input())).toBe(trimStopText({ why: 'timeline-start', clipId: 'a' }, proj()));
    expect(reasonFor('nudge-right', input())).toBeNull();
    open({ select: ['a'], touch: true });
    expect(reasonFor('nudge-right-big', input())).toBe(trimStopText({ why: 'overlap', clipId: 'a', otherId: 'a2' }, proj()));
    open({ select: ['a'], lock: true });
    expect(reasonFor('nudge-right', input())).toBe(trimStopText({ why: 'locked', clipId: 'a' }, proj()));
    // a blocked edge answers with the edge row's text
    open({ select: ['v'], edge: { clipId: 'v', edge: 'start', both: false, alone: false } });
    const why = reasonFor('nudge-left', input());
    expect(why).not.toBeNull();
    expect(why).toBe(reasonFor('edge-prev', input()));
    expect(reasonFor('nudge-right', input())).toBeNull();
    // a gone edge is no edge: the clips answer
    open({ select: [], edge: { clipId: 'ghost', edge: 'end', both: false, alone: false } });
    expect(reasonFor('nudge-right', input())).toBe(T.selectClip);
  });

  it('go-to-time only for addClip and sourceHasKeys', () => {
    const T = REASON_TEXT;
    open({ clips: false });
    expect(reasonFor('go-to-time', input())).toBe(T.addClip);
    open({ source: true });
    expect(reasonFor('go-to-time', input())).toBe(T.sourceHasKeys);
    for (const s of [{}, { select: ['a'] }, { select: ['a'], lock: true }, { time: 100 }, { select: ['v'], edge: { clipId: 'v', edge: 'start' as const, both: false, alone: false } }, { edge: { clipId: 'ghost', edge: 'end' as const, both: false, alone: false } }] as Setup[]) {
      open(s);
      expect(reasonFor('go-to-time', input()), JSON.stringify(s)).toBeNull();
    }
    expect(reasonFor('go-to-time', { project: null, selection: [], time: 0, canUndo: false, canRedo: false, clipboard: 0, zoom: 4 })).toBeNull();
  });

  it('nudge and edit rows: a text exactly when the row changes nothing', () => {
    const e = (clipId: string, edge: 'start' | 'end', both = false, alone = false): TrimEdge => ({ clipId, edge, both, alone });
    const states: Setup[] = [
      { clips: false },
      { select: [], time: 1 },
      { select: ['a'], time: 1 },
      { select: ['b'], time: 4 },
      { select: ['a'], time: 1, touch: true },
      { select: ['a'], time: 0 },
      { select: ['a'], time: 1, mate: true },
      { select: ['a'], time: 1, lock: true },
      { select: ['a', 'b'], time: 1.5 },
      { select: ['v'], time: 8 },
      { select: ['b'], time: 0, edge: e('b', 'start') },
      { select: ['b'], time: 0, edge: e('b', 'end') },
      { select: ['b'], time: 0, edge: e('b', 'start', false, true) },
      { select: ['a', 'a2'], time: 0, touch: true, edge: e('a', 'end', true) },
      { select: ['a', 'a2'], time: 0, touch: true, edge: e('a', 'end', true, true) },
      { select: ['v'], time: 0, edge: e('v', 'start') },
      { select: ['v'], time: 0, edge: e('v', 'end') },
      { select: ['a'], time: 0, edge: e('ghost', 'end') },
      { select: [], time: 0, edge: e('ghost', 'start') },
      { select: ['a'], time: 0 },
      { select: ['v'], time: 8 },
      { select: ['a'], time: 1, source: true },
    ];
    const ids = [...NUDGES, ...EDITS];
    const snap = () => JSON.stringify({
      project: proj(), selection: ed().selection, time: usePlayback.getState().time, edge: liveEdge(proj(), useUi.getState().trimEdge),
    });
    let withText = 0;
    let without = 0;
    for (const id of ids) {
      const row = SHORTCUTS.find((x) => x.id === id);
      expect(row, id).toBeDefined();
      expect(REASON_IDS.has(id), id).toBe(true);
      for (const s of states) {
        open(s);
        resetNudgeState();
        const why = reasonFor(id, reasonSnapshot());
        const before = snap();
        row!.run();
        const same = snap() === before;
        expect(same, `${id} in ${JSON.stringify(s)}: ${why}`).toBe(why !== null);
        if (why !== null) withText++;
        else without++;
      }
    }
    expect(withText).toBeGreaterThan(10);
    expect(without).toBeGreaterThan(10);
  });
});
