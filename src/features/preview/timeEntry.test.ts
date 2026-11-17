import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VideoClip } from '../../types';
import { DEFAULT_TRANSFORM } from '../../types';
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { REASON_TEXT } from '../shell/reasons';
import { closeTimeEntry, getTimeEntry, goToTime, goToTimeKey, openTimeEntry, registerTimeField, subscribeTimeEntry } from './timeEntry';
import { ENTRY_TEXT, fill } from './timeEntryPlan';

/** a project, with one clip or none */
function open(withClip: boolean): void {
  const p = createProject('time entry');
  const clip: VideoClip = {
    id: 'c1', type: 'video', trackId: p.tracks[0]!.id, start: 0, duration: 4, name: 'c', fadeIn: 0, fadeOut: 0, assetId: 'va',
    trimStart: 0, speed: 1, volume: 1, muted: false, transform: { ...DEFAULT_TRANSFORM },
  };
  useEditor.getState().openProject({ ...p, clips: withClip ? [clip] : [] });
}

const toasts = (): string[] => useUi.getState().toasts.map((t) => t.message);

beforeEach(() => {
  closeTimeEntry();
  useUi.setState({ toasts: [], previewMode: 'output', programMode: 'output' });
  open(true);
  useUi.setState({ toasts: [] });
});

describe('timeEntry', () => {
  it('no field, open is false', () => {
    expect(openTimeEntry('playhead')).toBe(false);
    expect(getTimeEntry()).toBeNull();
  });

  it('open notifies once and n counts', () => {
    const un = registerTimeField();
    const fn = vi.fn();
    const off = subscribeTimeEntry(fn);
    const back = { tabIndex: 0 } as unknown as HTMLElement;
    expect(openTimeEntry('timeline', back)).toBe(true);
    expect(fn).toHaveBeenCalledTimes(1);
    const first = getTimeEntry()!;
    expect(first.from).toBe('timeline');
    expect(first.returnTo).toBe(back);
    expect(openTimeEntry('playhead')).toBe(true);
    expect(fn).toHaveBeenCalledTimes(2);
    const second = getTimeEntry()!;
    expect(second.from).toBe('playhead');
    expect(second.returnTo).toBeNull();
    expect(second.n).toBe(first.n + 1);
    off();
    openTimeEntry('playhead');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(getTimeEntry()!.n).toBe(first.n + 2);
    un();
  });

  it('close', () => {
    const un = registerTimeField();
    const fn = vi.fn();
    const off = subscribeTimeEntry(fn);
    closeTimeEntry();
    expect(fn).not.toHaveBeenCalled();
    openTimeEntry('playhead');
    expect(getTimeEntry()).not.toBeNull();
    fn.mockClear();
    closeTimeEntry();
    expect(getTimeEntry()).toBeNull();
    expect(fn).toHaveBeenCalledTimes(1);
    closeTimeEntry();
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    un();
  });

  it('the last unregister closes', () => {
    const a = registerTimeField();
    const b = registerTimeField();
    openTimeEntry('playhead');
    a();
    expect(getTimeEntry()).not.toBeNull();
    expect(openTimeEntry('timeline')).toBe(true);
    b();
    expect(getTimeEntry()).toBeNull();
    expect(openTimeEntry('playhead')).toBe(false);
  });

  it('goToTime with a reason only toasts', () => {
    const un = registerTimeField();
    open(false);
    useUi.setState({ toasts: [] });
    goToTime('timeline');
    expect(toasts()).toEqual([REASON_TEXT.addClip]);
    expect(getTimeEntry()).toBeNull();
    // the source view has the keys
    open(true);
    useUi.setState({ toasts: [], previewMode: 'source' });
    goToTime('timeline');
    expect(toasts()).toEqual([REASON_TEXT.sourceHasKeys]);
    expect(getTimeEntry()).toBeNull();
    // no reason: it opens and says nothing
    useUi.setState({ toasts: [], previewMode: 'output' });
    goToTime('timeline');
    expect(toasts()).toEqual([]);
    expect(getTimeEntry()!.from).toBe('timeline');
    closeTimeEntry();
    // no field on screen: say so
    un();
    goToTime('playhead');
    expect(toasts()).toEqual([ENTRY_TEXT.noField]);
    expect(getTimeEntry()).toBeNull();
  });

  it('goToTimeKey from a fake closest() target', () => {
    const un = registerTimeField();
    const asked: string[] = [];
    const inStage = { closest: (s: string) => (asked.push(s), {}) };
    const onTimeline = { closest: (s: string) => (asked.push(s), null) };
    const key = (target: unknown) => ({ target }) as unknown as KeyboardEvent;
    goToTimeKey(key(inStage));
    expect(getTimeEntry()!.from).toBe('playhead');
    // no dom here: nothing to give focus back to
    expect(getTimeEntry()!.returnTo).toBeNull();
    expect(asked[0]).toContain('.preview-stage');
    goToTimeKey(key(onTimeline));
    expect(getTimeEntry()!.from).toBe('timeline');
    goToTimeKey(key(null));
    expect(getTimeEntry()!.from).toBe('timeline');
    closeTimeEntry();
    un();
  });

  it('fill replaces known names and leaves the others', () => {
    expect(fill(ENTRY_TEXT.moveBlocked, { amt: '+00:00:15', why: 'it is locked' })).toBe('cannot move +00:00:15: it is locked');
    expect(fill(ENTRY_TEXT.moveMany, { n: 3 })).toBe('move 3 clips {amt}');
    expect(fill('{a}{a} {b}', { a: 1 })).toBe('11 {b}');
  });
});
