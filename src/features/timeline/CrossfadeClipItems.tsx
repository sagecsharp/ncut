import { AudioWaveform, Eraser } from 'lucide-react';
import { DEFAULT_CROSSFADE } from '../../types';
import type { Project } from '../../types';
import { cleanCrossfade, hasSound, soundAfter } from '../../lib/audioCross';
import { hasSoundApart } from '../../lib/soundPair';
import { useEditor } from '../../store/editorStore';
import { MenuKeys } from '../shell/MenuKeys';
import { reasonSnapshot } from '../shell/reasons';
import { tip } from '../shell/tip';
import { crossfadeNow, setCrossfadeNow } from './crossfadeActions';
import { crossfadeReason, planSetCrossfade } from './crossfadePlan';
import { CROSS_TEXT } from './crossfadeText';

interface Props {
  clipId: string;
  ids: readonly string[];
  onDone(): void;
}

const hasStored = (p: Project, id: string): boolean => {
  const c = p.clips.find((x) => x.id === id);
  return (c?.type === 'video' || c?.type === 'audio') && cleanCrossfade(c.crossfade) !== null;
};

/** the crossfade items of the clip menu: the start and the end of one clip with sound, or the edits of several */
export function CrossfadeClipItems({ clipId, ids, onDone }: Props) {
  const p = useEditor.getState().project;
  const clip = p?.clips.find((c) => c.id === clipId);
  if (!p || !clip || (clip.type !== 'video' && clip.type !== 'audio')) return null;
  const sound = hasSound(p, clip) || hasSoundApart(p.clips, clip.id);
  const run = (fn: () => void) => () => {
    fn();
    onDone();
  };

  if (ids.length > 1) {
    const some = ids.some((id) => {
      const c = p.clips.find((x) => x.id === id);
      return !!c && (c.type === 'video' || c.type === 'audio') && (hasSound(p, c) || hasSoundApart(p.clips, c.id));
    });
    if (!some) return null;
    const off = crossfadeReason('crossfade', reasonSnapshot());
    return (
      <>
        <div className="menu-sep" />
        <button
          className="menu-item"
          role="menuitem"
          disabled={off !== null}
          {...tip('crossfade the selected clips', { does: 'a crossfade at every edit between two selected clips with sound, or at their ends. again: remove them', side: 'right', keys: 'crossfade', off })}
          onClick={run(crossfadeNow)}
        >
          <AudioWaveform size={14} />
          crossfade the selected clips
          <MenuKeys id="crossfade" />
        </button>
      </>
    );
  }

  if (!sound) return null;
  const after = soundAfter(p, clip);
  const item = (where: 'start' | 'end', toId: string | undefined) => {
    const has = toId !== undefined && hasStored(p, toId);
    const plan = toId === undefined ? CROSS_TEXT.crossNoEdit : planSetCrossfade(p, toId, has ? { remove: true } : { length: DEFAULT_CROSSFADE, place: 'center' });
    const off = typeof plan === 'string' ? plan : null;
    const label = has ? `remove crossfade at the ${where}` : `crossfade at the ${where}`;
    return (
      <button
        key={where}
        className="menu-item"
        role="menuitem"
        disabled={off !== null}
        {...tip(label, {
          does: has ? 'the edit is a hard edit for the sound again' : `the sound of the clip ${where === 'start' ? 'before fades out while this one fades in' : 'after fades in while this one fades out'}, over ${DEFAULT_CROSSFADE}s centered on the edit`,
          side: 'right',
          off,
        })}
        onClick={run(() => {
          if (toId !== undefined) setCrossfadeNow(toId, has ? { remove: true } : { length: DEFAULT_CROSSFADE, place: 'center' });
        })}
      >
        {has ? <Eraser size={14} /> : <AudioWaveform size={14} />}
        {label}
      </button>
    );
  };
  return (
    <>
      <div className="menu-sep" />
      {item('start', clip.id)}
      {item('end', after?.id)}
    </>
  );
}
