import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  ArrowDown,
  ArrowRightToLine,
  ArrowUp,
  AudioWaveform,
  ChevronsRightLeft,
  Crosshair,
  Eraser,
  Eye,
  EyeOff,
  Headphones,
  Layers,
  ListChecks,
  Lock,
  MoveHorizontal,
  Pin,
  Replace,
  Trash2,
  UnfoldVertical,
  Unlock,
  Volume2,
  VolumeX,
} from 'lucide-react';
import type { Track } from '../../types';
import { hasSound } from '../../lib/audioCross';
import { HEAD_FULL_H, stepIndex, syncLockOf, trackHeightOf } from '../../lib/trackTools';
import { trackSoundLine } from '../../lib/mix';
import { useEditor } from '../../store/editorStore';
import { useSolo } from '../../store/solo';
import { useSource } from '../../store/source';
import { useUi } from '../../store/ui';
import { lastTransition } from '../media/transitionApply';
import { cutsOnTrack, planRemoveTransitions, planTrackTransitions } from '../media/transitionBatch';
import type { TransitionPatch } from '../media/transitionBatch';
import { MenuKeys } from '../shell/MenuKeys';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { crossfadeTracksNow } from './crossfadeActions';
import { planTrackCrossfades } from './crossfadePlan';
import { closeGapsOnTrack, insertGapAt, selectAfterPlayhead, selectTrackClips } from './actions';
import { toggleTargetOf, useIsTarget } from './editTargets';
import { useFloatingMenu } from './menuBehavior';
import { headToggles } from './headToggles';
import type { HeadState, HeadToggle } from './headToggles';
import { moveTrackStep, setTrackHeight, toggleSyncLock } from './trackActions';

/** write a plan as one undo step */
function applyPlan(patches: TransitionPatch[]): void {
  const st = useEditor.getState();
  st.pushHistory();
  for (const p of patches) st.updateClip(p.clipId, { transition: p.transition }, { skipHistory: true });
}

const plural = (n: number) => `${n} transition${n === 1 ? '' : 's'}`;

function addEverywhere(trackId: string, replace: boolean): void {
  const project = useEditor.getState().project;
  if (!project) return;
  const patches = planTrackTransitions(project, trackId, lastTransition(), replace);
  if (patches.length === 0) {
    const locked = project.tracks.find((t) => t.id === trackId)?.locked;
    const cuts = cutsOnTrack(project, trackId).length;
    useUi
      .getState()
      .toast(
        locked
          ? 'nothing to do: this track is locked'
          : cuts === 0
            ? 'nothing to do: no cuts on this track'
            : replace
              ? 'nothing to do: every cut already has this transition'
              : 'nothing to do: every cut already has a transition',
      );
    return;
  }
  applyPlan(patches);
  useUi.getState().toast(`${plural(patches.length)} ${replace ? 'set' : 'added'}`);
}

function removeEverywhere(trackId: string): void {
  const project = useEditor.getState().project;
  if (!project) return;
  if (project.tracks.find((t) => t.id === trackId)?.locked) {
    useUi.getState().toast('this track is locked');
    return;
  }
  const patches = planRemoveTransitions(project, trackId);
  if (patches.length === 0) {
    useUi.getState().toast('nothing to do: no transitions on this track');
    return;
  }
  applyPlan(patches);
  useUi.getState().toast(`${plural(patches.length)} removed`);
}

export interface TrackMenuRequest {
  x: number;
  y: number;
  trackId: string;
  /** a menu opened from the keyboard puts the focus on its first item */
  focusFirst?: boolean;
}

interface Props extends TrackMenuRequest {
  onClose(): void;
}

interface CompactProps {
  track: Track;
  onClose(): void;
}

/** what a short header has no room for: its toggles, the mixer and remove. an inner component so its hooks always run */
function CompactItems({ track, onClose }: CompactProps) {
  const shown = useSource((s) => s.assetId !== null);
  const solo = useSolo((s) => s.solo.includes(track.id));
  const isTarget = useIsTarget(track);
  const clipCount = useEditor((s) => (s.project?.clips ?? []).filter((c) => c.trackId === track.id).length);
  const [confirm, setConfirm] = useState(false);
  useEffect(() => {
    if (!confirm) return;
    const timer = window.setTimeout(() => setConfirm(false), 2500);
    return () => window.clearTimeout(timer);
  }, [confirm]);
  if (trackHeightOf(track) >= HEAD_FULL_H) return null;
  const state: HeadState = { video: track.kind === 'video', target: shown, muted: !!track.muted, solo, hidden: !!track.hidden, locked: !!track.locked, syncOff: !syncLockOf(track) };
  const inHead = new Set<HeadToggle>(headToggles(state, true));
  const hidden = headToggles(state, false).filter((t) => t !== 'sync' && !inHead.has(t));
  const update = (patch: Partial<Pick<Track, 'muted' | 'hidden' | 'locked'>>) => useEditor.getState().updateTrack(track.id, patch);
  const part = track.kind === 'video' ? 'picture' : 'sound';
  const item = (id: HeadToggle): ReactNode => {
    const check = (label: string, on: boolean, icon: ReactNode, does: string, act: () => void) => (
      <button key={id} className="menu-item" role="menuitemcheckbox" aria-checked={on} {...tip(label, { does, on, side: 'right' })} onClick={act}>
        {icon}
        {label}
      </button>
    );
    switch (id) {
      case 'target':
        return check(
          `${part} target`,
          isTarget,
          <Crosshair size={14} />,
          `insert, overwrite, fit and append put the ${part} on this track. a click on the lit one turns the ${part} off`,
          () => {
            if (!toggleTargetOf(track)) useUi.getState().toast(REASON_TEXT.trackLocked);
          },
        );
      case 'mute':
        return check('mute track', !!track.muted, track.muted ? <VolumeX size={14} /> : <Volume2 size={14} />, 'no sound from this track', () => update({ muted: !track.muted }));
      case 'solo':
        return check('solo track', solo, <Headphones size={14} />, 'hear only the tracks on solo. for listening only: it is not saved and the export has every track', () =>
          useSolo.getState().toggleSolo(track.id, false),
        );
      case 'hide':
        return check('hide track', !!track.hidden, track.hidden ? <EyeOff size={14} /> : <Eye size={14} />, 'its clips are not drawn, in the preview and in the export', () => update({ hidden: !track.hidden }));
      case 'lock':
        return check('lock track', !!track.locked, track.locked ? <Lock size={14} /> : <Unlock size={14} />, 'its clips cannot be moved or changed', () => update({ locked: !track.locked }));
      default:
        return null;
    }
  };
  const remove = () => {
    if (clipCount > 0 && !confirm) {
      setConfirm(true);
      return;
    }
    useEditor.getState().removeTrack(track.id);
    onClose();
  };
  return (
    <>
      {hidden.map(item)}
      {trackSoundLine(track) !== '' ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('open the mixer at this track', { does: 'this track has its own level or pan. open the mixer at it', side: 'right', keys: 'open-mixer' })}
          onClick={() => {
            useUi.getState().showMixer(track.id);
            onClose();
          }}
        >
          <Volume2 size={14} />
          open the mixer at this track
          <MenuKeys id="open-mixer" />
        </button>
      ) : null}
      <button
        className={`menu-item${confirm ? ' is-confirm' : ''}`}
        role="menuitem"
        {...tip(confirm ? 'click again to remove the track and its clips' : 'remove track', { does: 'a track with clips asks for a second click', side: 'right' })}
        onClick={remove}
      >
        <Trash2 size={14} />
        {confirm ? 'click again to remove the track and its clips' : 'remove track'}
      </button>
    </>
  );
}

/** right click menu of a track header or an empty spot of a lane. */
export function TrackMenu({ x, y, trackId, focusFirst, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pos = useFloatingMenu(ref, x, y, onClose, { focusFirst });
  const track = useEditor((s) => s.project?.tracks.find((t) => t.id === trackId));
  const up = useEditor((s) => (s.project ? stepIndex(s.project.tracks, trackId, -1) : null));
  const down = useEditor((s) => (s.project ? stepIndex(s.project.tracks, trackId, 1) : null));
  // an audio track, or a track with a clip with sound
  const sound = useEditor((s) => track?.kind === 'audio' || (!!s.project && s.project.clips.some((c) => c.trackId === trackId && hasSound(s.project!, c))));
  if (!track) return null;
  const lockedOff = track.locked ? REASON_TEXT.trackLocked : null;
  const project = useEditor.getState().project;
  const addPlan = sound && project ? planTrackCrossfades(project, [trackId], 'add') : null;
  const removePlan = sound && project ? planTrackCrossfades(project, [trackId], 'remove') : null;
  const addOff = lockedOff ?? (typeof addPlan === 'string' ? addPlan : null);
  const removeOff = lockedOff ?? (typeof removePlan === 'string' ? removePlan : null);
  const syncOn = syncLockOf(track);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };
  return (
    <div ref={ref} className="menu timeline-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button
        className="menu-item"
        role="menuitem"
        {...tip('select everything on this track', { does: 'select every clip on this track', side: 'right' })}
        onClick={run(() => selectTrackClips(trackId))}
      >
        <ListChecks size={14} />
        select everything on this track
      </button>
      <button
        className="menu-item"
        role="menuitem"
        {...tip('select everything after the playhead', { does: 'select every clip that starts at or after the playhead', side: 'right', keys: 'select-after' })}
        onClick={run(() => selectAfterPlayhead())}
      >
        <ArrowRightToLine size={14} />
        select everything after the playhead
        <MenuKeys id="select-after" />
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        {...tip('close gaps on this track', { does: 'move the clips of this track left so they sit end to end', side: 'right', off: lockedOff })}
        onClick={run(() => closeGapsOnTrack(trackId))}
      >
        <ChevronsRightLeft size={14} />
        close gaps on this track
      </button>
      <button
        className="menu-item"
        role="menuitem"
        {...tip('insert gap here', { does: 'push every clip that starts at or after the playhead right by 1 second, on every unlocked track with sync lock on', side: 'right' })}
        onClick={run(() => insertGapAt())}
      >
        <MoveHorizontal size={14} />
        insert gap here
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        {...tip('insert gap on this track', { does: 'the same, but only for the clips of this track', side: 'right', off: lockedOff })}
        onClick={run(() => insertGapAt(undefined, trackId))}
      >
        <MoveHorizontal size={14} />
        insert gap on this track
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        {...tip('transition on every cut', { does: 'put the transition used last on every cut of this track that has none', side: 'right', off: lockedOff })}
        onClick={run(() => addEverywhere(trackId, false))}
      >
        <Layers size={14} />
        transition on every cut
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        {...tip('replace every transition', { does: 'put the transition used last on every cut of this track, replacing the ones there', side: 'right', off: lockedOff })}
        onClick={run(() => addEverywhere(trackId, true))}
      >
        <Replace size={14} />
        replace every transition
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked}
        {...tip('remove every transition', { does: 'remove the transition from every clip of this track', side: 'right', off: lockedOff })}
        onClick={run(() => removeEverywhere(trackId))}
      >
        <Eraser size={14} />
        remove every transition
      </button>
      {sound ? (
        <>
          <button
            className="menu-item"
            role="menuitem"
            disabled={addOff !== null}
            {...tip('crossfade every edit on this track', { does: 'a crossfade at every edit between two clips with sound (0.25s, equal power). the ones there stay, an edit inside one take is left alone', side: 'right', off: addOff })}
            onClick={run(() => crossfadeTracksNow([trackId], 'add'))}
          >
            <AudioWaveform size={14} />
            crossfade every edit on this track
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={removeOff !== null}
            {...tip('remove every crossfade on this track', { does: 'every edit of this track is a hard edit for the sound again', side: 'right', off: removeOff })}
            onClick={run(() => crossfadeTracksNow([trackId], 'remove'))}
          >
            <Eraser size={14} />
            remove every crossfade on this track
          </button>
        </>
      ) : null}
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked || up === null}
        {...tip('move track up', {
          does: 'one place up. a video track higher up draws on top of the ones under it',
          side: 'right',
          off: lockedOff ?? (up === null ? REASON_TEXT.trackTop : null),
        })}
        onClick={run(() => moveTrackStep(trackId, -1))}
      >
        <ArrowUp size={14} />
        move track up
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.locked || down === null}
        {...tip('move track down', { does: 'one place down', side: 'right', off: lockedOff ?? (down === null ? REASON_TEXT.trackBottom : null) })}
        onClick={run(() => moveTrackStep(trackId, 1))}
      >
        <ArrowDown size={14} />
        move track down
      </button>
      <button
        className="menu-item"
        role="menuitemcheckbox"
        aria-checked={syncOn}
        {...tip('sync lock', {
          does: 'on: ripple, insert and extract on other tracks move this track too, so it stays in sync. off: it stays where it is. shift+click: every track of this kind',
          on: syncOn,
          side: 'right',
        })}
        onClick={(e) => {
          if (!e.shiftKey) {
            toggleSyncLock([trackId]);
            return;
          }
          const ids = (useEditor.getState().project?.tracks ?? []).filter((t) => t.kind === track.kind).map((t) => t.id);
          toggleSyncLock(ids, !syncOn);
        }}
      >
        {syncOn ? <MoveHorizontal size={14} /> : <Pin size={14} />}
        sync lock
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={track.height === undefined}
        {...tip('normal height', { does: 'the track gets its normal height again', side: 'right', off: track.height === undefined ? REASON_TEXT.trackNormal : null })}
        onClick={run(() => setTrackHeight(trackId, null))}
      >
        <UnfoldVertical size={14} />
        normal height
      </button>
      <CompactItems track={track} onClose={onClose} />
    </div>
  );
}
