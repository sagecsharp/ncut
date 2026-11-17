import { useRef } from 'react';
import { createPortal } from 'react-dom';
import { AudioWaveform, Blend, Eraser, SlidersHorizontal } from 'lucide-react';
import { SHAPE_NAME } from '../../lib/audioCross';
import { cleanCrossfade } from '../../lib/audioCross';
import { FADE_SHAPES } from '../../types';
import type { FadeShape } from '../../types';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { MenuKeys } from '../shell/MenuKeys';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { crossfadeWithTransitionNow, setCrossfadeNow, useCrossfadeMenu } from './crossfadeActions';
import type { Place } from './crossfadePlan';
import { placeOf } from './crossfadePlan';
import { useFloatingMenu } from './menuBehavior';

interface Props {
  clipId: string;
  anchor: HTMLElement | null;
}

const PLACES: { id: Exclude<Place, 'custom'>; label: string; does: string }[] = [
  { id: 'center', label: 'centered on the edit', does: 'half of the crossfade before the edit, half after it' },
  { id: 'start', label: 'starts at the edit', does: 'the whole crossfade after the edit: the sound of the clip before fades out as this clip begins' },
  { id: 'end', label: 'ends at the edit', does: 'the whole crossfade before the edit: it is over when this clip begins' },
];
const LENGTHS = [0.1, 0.25, 0.5, 1];
const SHAPE_DOES: Record<FadeShape, string> = {
  power: 'keeps the loudness of two different sounds',
  linear: 'a straight fade, for two parts of one take',
  smooth: 'slow at both ends',
};

/** the menu of a crossfade: shape, place, length, the transition link, its part of the sound tab and remove. rendered by its box, on the page */
export function CrossfadeMenu({ clipId, anchor }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const open = useCrossfadeMenu((s) => s.menu);
  const close = useCrossfadeMenu((s) => s.close);
  const clip = useEditor((s) => s.project?.clips.find((c) => c.id === clipId));
  const fps = useEditor((s) => s.project?.fps || 30);
  const locked = useEditor((s) => !!s.project?.tracks.find((t) => t.id === s.project?.clips.find((c) => c.id === clipId)?.trackId)?.locked);
  const rect = anchor?.getBoundingClientRect();
  const x = open?.at?.x ?? rect?.left ?? 0;
  const y = open?.at?.y ?? rect?.bottom ?? 0;
  const pos = useFloatingMenu(ref, x, y, close, { focusFirst: open?.at === null });
  if (!open || open.clipId !== clipId || !clip || (clip.type !== 'video' && clip.type !== 'audio')) return null;
  const cur = cleanCrossfade(clip.crossfade);
  if (!cur) return null;
  const shape: FadeShape = cur.shape ?? 'power';
  const place = placeOf(cur, fps);
  const total = cur.before + cur.after;
  const off = locked ? REASON_TEXT.trackLocked : null;
  const withTransition = clip.type === 'video' && !!clip.transition;
  const run = (fn: () => void) => () => {
    fn();
    close();
  };
  return createPortal(
    // the menu sits in the box in the react tree: a press in it must not reach the box
    <div
      ref={ref}
      className="menu timeline-menu"
      style={{ left: pos.x, top: pos.y }}
      role="menu"
      onPointerDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
    >
      {FADE_SHAPES.map((s) => (
        <button
          key={s}
          className="menu-item"
          role="menuitemradio"
          aria-checked={shape === s}
          disabled={locked}
          {...tip(SHAPE_NAME[s], { does: SHAPE_DOES[s], side: 'right', on: shape === s, off })}
          onClick={run(() => void setCrossfadeNow(clipId, { shape: s }))}
        >
          <AudioWaveform size={14} />
          {SHAPE_NAME[s]}
        </button>
      ))}
      <div className="menu-sep" />
      {PLACES.map((pl) => (
        <button
          key={pl.id}
          className="menu-item"
          role="menuitemradio"
          aria-checked={place === pl.id}
          disabled={locked}
          {...tip(pl.label, { does: pl.does, side: 'right', on: place === pl.id, off })}
          onClick={run(() => void setCrossfadeNow(clipId, { place: pl.id }))}
        >
          <SlidersHorizontal size={14} />
          {pl.label}
        </button>
      ))}
      <div className="menu-sep" />
      {LENGTHS.map((len) => (
        <button
          key={len}
          className="menu-item"
          role="menuitem"
          disabled={locked}
          {...tip(`length ${len}s`, { does: `the crossfade is ${len}s long, on the place it has now`, side: 'right', off })}
          onClick={run(() => void setCrossfadeNow(clipId, { length: len }))}
        >
          <SlidersHorizontal size={14} />
          {`length ${len}s`}
          {Math.abs(total - len) < 0.5 / fps ? <span className="menu-hint">now</span> : null}
        </button>
      ))}
      {withTransition ? (
        <button
          className="menu-item"
          role="menuitemcheckbox"
          aria-checked={!!cur.withTransition}
          disabled={locked}
          {...tip('same length as the transition', { does: 'the crossfade follows the transition of this clip: the same length and place', side: 'right', on: !!cur.withTransition, off })}
          onClick={run(() => crossfadeWithTransitionNow(clipId, !cur.withTransition))}
        >
          <Blend size={14} />
          same length as the transition
        </button>
      ) : null}
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        {...tip('show in the sound tab', { does: 'open the crossfade part of the sound tab for this clip', side: 'right' })}
        onClick={run(() => useUi.getState().revealSection('crossfade'))}
      >
        <AudioWaveform size={14} />
        show in the sound tab
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={locked}
        {...tip('remove crossfade', { does: 'the edit is a hard edit for the sound again', side: 'right', keys: 'delete', off })}
        onClick={run(() => void setCrossfadeNow(clipId, { remove: true }))}
      >
        <Eraser size={14} />
        remove crossfade
        <MenuKeys id="delete" />
      </button>
    </div>,
    document.body,
  );
}
