import { useRef } from 'react';
import { AlignHorizontalJustifyStart, ArrowLeftRight, AudioLines, Blend, Box, CopyPlus, Diamond, Film, Flag, Gauge, Group, Layers, ListEnd, Merge, MousePointer2, MoveHorizontal, Paperclip, Replace, Scissors, Snowflake, Sparkles, Split, Square, Target, Type, Trash2, Ungroup, Unlink, Volume2, VolumeX } from 'lucide-react';
import { hasKeyframes } from '../../lib/anim';
import { muteTargets } from '../../lib/soundPair';
import { isVisualClip } from '../../types';
import { clipEnd } from '../../lib/timelineOps';
import { childrenOf, parentOf } from '../../lib/links';
import { attachClips } from '../properties/attachActions';
import { SPLIT_MODES, splitPlans, splitReason, splitText } from '../properties/textSplitActions';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { MenuKeys } from '../shell/MenuKeys';
import { REASON_TEXT } from '../shell/reasons';
import { tip } from '../shell/tip';
import { applyEffectsToEverything, clearKeysOf, freezeAtPlayhead, goToEffectTarget, groupIdsNow, selectEffectsOf, ungroupIdsNow } from './actions';
import { clearBeatMarkers, clipHasSound, markBeats } from './beatActions';
import { getEffect } from '../../engine/effects/registry';
import { effectsOn } from './effectTarget';
import { CrossfadeClipItems } from './CrossfadeClipItems';
import { useFloatingMenu } from './menuBehavior';
import { cutAtMarkers, fitToMarkers, makeRow, canCutAtMarkers, sequenceableIds } from './sequenceActions';
import { swapCandidates } from './swap';
import { soundMenu } from './soundPlan';
import { joinSoundNow, selectSideNow, separateSoundNow, syncSoundNow } from './soundActions';

interface Props {
  x: number;
  y: number;
  clipId: string;
  /** opened from the keyboard: the focus goes to the first item */
  focusFirst?: boolean;
  onClose(): void;
}

/** right click menu for a clip. closes on outside click, escape, scroll, resize and blur. */
export function ClipMenu({ x, y, clipId, focusFirst, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const clip = useEditor((s) => s.project?.clips.find((c) => c.id === clipId));
  const selection = useEditor((s) => s.selection);

  const pos = useFloatingMenu(ref, x, y, onClose, { focusFirst });

  if (!clip) return null;
  const ids = selection.includes(clipId) ? selection : [clipId];
  const time = usePlayback.getState().time;
  const canSplit = !!useEditor
    .getState()
    .project?.clips.some((c) => ids.includes(c.id) && time > c.start + 0.05 && time < clipEnd(c) - 0.05);
  const timed = clip.type === 'video' || clip.type === 'audio';
  const project = useEditor.getState().project;
  // a picture with its sound apart shows the mute of its sound clip
  const muted = project ? (muteTargets(project.clips, [clip.id])[0]?.muted ?? false) : (clip.type === 'video' || clip.type === 'audio') && clip.muted;
  const sm = project ? soundMenu(project, ids, clip.id) : null;
  const showSound = !!sm && (sm.canSeparate || sm.join !== null || sm.sound || sm.picture || sm.offset !== null);
  const joinOff = sm && sm.join !== null && sm.join !== 'yes' ? sm.join : null;
  const picked = (project?.clips ?? []).filter((c) => ids.includes(c.id));
  const withTransition = picked.filter((c) => isVisualClip(c) && c.transition);
  const withKeys = picked.filter((c) => hasKeyframes(c));
  const visual = picked.filter(isVisualClip);
  const grouped = picked.some((c) => c.group);
  const children = project ? childrenOf(project, clip.id) : [];
  const parent = project ? parentOf(project, clip) : null;
  const attached = project ? picked.filter(isVisualClip).filter((c) => parentOf(project, c)) : [];
  const inClip = time >= clip.start && time <= clipEnd(clip);
  const is3d = visual.length > 0 && visual.every((c) => c.threeD);
  const effectsHere = project ? visual.flatMap((c) => effectsOn(project.clips, c.id)) : [];
  const targetedEffects = picked.filter((c) => c.type === 'effect' && c.target);
  const allOwn = targetedEffects.length > 0 && targetedEffects.every((c) => c.type === 'effect' && getEffect(c.effect)?.alpha === 'own');
  const targetClip = clip.type === 'effect' && clip.target && project ? project.clips.find((c) => c.id === clip.target) : undefined;

  const swaps = project ? swapCandidates(project.assets, clip) : [];
  const canSplitAll = !!project?.clips.some((c) => time > c.start + 0.05 && time < clipEnd(c) - 0.05);

  const sounds = clipHasSound(project, clip);
  const seqIds = sequenceableIds(project, ids);
  const hasMarkers = (project?.markers?.length ?? 0) > 0;
  const cutIds = picked.filter((c) => canCutAtMarkers(project, c)).map((c) => c.id);

  // a single text clip: the ways it can be split into one clip per piece (only the ones that would do something)
  const splitPlansHere = ids.length === 1 && clip.type === 'text' ? splitPlans(clip) : null;
  const splitModes = SPLIT_MODES.filter((m) => splitPlansHere && splitReason(splitPlansHere[m]) === null);

  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return (
    <div ref={ref} className="menu timeline-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      <button
        className="menu-item"
        role="menuitem"
        disabled={!canSplit}
        {...tip('split at playhead', { does: 'split the selected clips at the playhead', side: 'right', keys: 'split', off: canSplit ? null : REASON_TEXT.playheadOnClip })}
        onClick={run(() => useEditor.getState().splitClips(usePlayback.getState().time, ids))}
      >
        <Scissors size={14} />
        split at playhead
        <MenuKeys id="split" />
      </button>
      <button
        className="menu-item"
        role="menuitem"
        disabled={!canSplitAll}
        {...tip('split all tracks here', { does: 'split every clip on every track at the playhead', side: 'right', off: canSplitAll ? null : REASON_TEXT.noClipUnder })}
        onClick={run(() => {
          const st = useEditor.getState();
          st.splitClips(usePlayback.getState().time, st.project?.clips.map((c) => c.id) ?? []);
        })}
      >
        <Scissors size={14} />
        split all tracks here
      </button>
      {cutIds.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('split at the markers', { does: 'split the selected clips at every marker inside them', side: 'right' })}
          onClick={run(() => cutAtMarkers(ids))}
        >
          <Flag size={14} />
          split at the markers
        </button>
      ) : null}
      <button
        className="menu-item"
        role="menuitem"
        {...tip('duplicate', { does: 'duplicate the selected clips', side: 'right', keys: 'duplicate' })}
        onClick={run(() => useEditor.getState().duplicateClips(ids))}
      >
        <CopyPlus size={14} />
        duplicate
        <MenuKeys id="duplicate" />
      </button>
      <div className="menu-sep" />
      <button
        className="menu-item"
        role="menuitem"
        {...tip('delete', { does: 'delete the selected clips', side: 'right', keys: 'delete' })}
        onClick={run(() => useEditor.getState().deleteClips(ids))}
      >
        <Trash2 size={14} />
        delete
        <MenuKeys id="delete" />
      </button>
      <button
        className="menu-item"
        role="menuitem"
        {...tip('ripple delete', { does: 'delete and close the gap', side: 'right', keys: 'ripple-delete' })}
        onClick={run(() => useEditor.getState().deleteClips(ids, { ripple: true }))}
      >
        <ListEnd size={14} />
        ripple delete
        <MenuKeys id="ripple-delete" />
      </button>
      {ids.length > 1 || grouped || children.length > 0 || parent || attached.length > 0 || clip.type === 'video' ? <div className="menu-sep" /> : null}
      {ids.length > 1 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('group', { does: 'move and edit these clips as one', side: 'right', keys: 'group' })}
          onClick={run(() => groupIdsNow(ids))}
        >
          <Group size={14} />
          group
          <MenuKeys id="group" />
        </button>
      ) : null}
      {grouped ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('ungroup', { does: 'ungroup: the clips stay where they are', side: 'right', keys: 'ungroup' })}
          onClick={run(() => ungroupIdsNow(ids))}
        >
          <Ungroup size={14} />
          ungroup
          <MenuKeys id="ungroup" />
        </button>
      ) : null}
      {children.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('select attached clips', { does: 'select this clip and the clips attached to it', side: 'right' })}
          onClick={run(() => useEditor.getState().select([clip.id, ...children.map((c) => c.id)], 'replace'))}
        >
          <MousePointer2 size={14} />
          select attached clips
        </button>
      ) : null}
      {parent ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('select what it is attached to', { does: 'select the clip this one is attached to', side: 'right' })}
          onClick={run(() => useEditor.getState().select([parent.id], 'replace'))}
        >
          <Paperclip size={14} />
          select what it is attached to
        </button>
      ) : null}
      {attached.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('detach', { does: 'detach the selected clips, they stay where they are', side: 'right' })}
          onClick={run(() => {
            // the shared action: one undo step, keeps the place on screen, leaves animated values alone
            attachClips(
              attached.map((c) => c.id),
              null,
            );
          })}
        >
          <Unlink size={14} />
          detach
        </button>
      ) : null}
      {clip.type === 'video' ? (
        <button
          className="menu-item"
          role="menuitem"
          disabled={!inClip}
          {...tip('freeze frame', { does: 'turn the frame at the playhead into a still', side: 'right', keys: 'freeze-frame', off: inClip ? null : 'move the playhead onto the clip first' })}
          onClick={run(freezeAtPlayhead)}
        >
          <Snowflake size={14} />
          freeze frame
          <MenuKeys id="freeze-frame" />
        </button>
      ) : null}
      {sm && showSound ? (
        <>
          <div className="menu-sep" />
          {sm.canSeparate ? (
            <button
              className="menu-item"
              role="menuitem"
              {...tip('separate sound', { does: 'put the sound on an audio track as a clip of its own, grouped with the picture', side: 'right', keys: 'separate-sound' })}
              onClick={run(() => separateSoundNow(ids))}
            >
              <Split size={14} />
              separate sound
              <MenuKeys id="separate-sound" />
            </button>
          ) : null}
          {sm.join !== null ? (
            <button
              className="menu-item"
              role="menuitem"
              disabled={joinOff !== null}
              {...tip('join sound back', { does: 'remove the sound clip: the picture plays its own sound again', side: 'right', keys: 'separate-sound', off: joinOff })}
              onClick={run(() => joinSoundNow(ids))}
            >
              <Merge size={14} />
              join sound back
              <MenuKeys id="separate-sound" />
            </button>
          ) : null}
          {sm.sound ? (
            <button
              className="menu-item"
              role="menuitem"
              {...tip('select only the sound', { does: 'select the sound clip alone, to trim it on its own (a j or l cut)', side: 'right' })}
              onClick={run(() => selectSideNow(ids, 'sound'))}
            >
              <AudioLines size={14} />
              select only the sound
            </button>
          ) : null}
          {sm.picture ? (
            <button
              className="menu-item"
              role="menuitem"
              {...tip('select only the picture', { does: 'select the picture alone, to trim it on its own', side: 'right' })}
              onClick={run(() => selectSideNow(ids, 'picture'))}
            >
              <Film size={14} />
              select only the picture
            </button>
          ) : null}
          {sm.offset !== null && sm.offset !== 'speed' ? (
            <>
              <button
                className="menu-item"
                role="menuitem"
                {...tip('move into sync', { does: 'move this clip so it lines up with its picture or sound again', side: 'right' })}
                onClick={run(() => syncSoundNow([clip.id], 'move'))}
              >
                <MoveHorizontal size={14} />
                move into sync
              </button>
              <button
                className="menu-item"
                role="menuitem"
                {...tip('slip into sync', { does: 'keep this clip where it is and slide its media so it lines up', side: 'right' })}
                onClick={run(() => syncSoundNow([clip.id], 'slip'))}
              >
                <ArrowLeftRight size={14} />
                slip into sync
              </button>
            </>
          ) : null}
          {sm.offset === 'speed' ? (
            <button
              className="menu-item"
              role="menuitem"
              {...tip('match the speed', { does: 'give this clip the speed of its picture or sound and line it up', side: 'right' })}
              onClick={run(() => syncSoundNow([clip.id], 'speed'))}
            >
              <Gauge size={14} />
              match the speed
            </button>
          ) : null}
        </>
      ) : null}
      {clip.type === 'text' && splitModes.length > 0 ? (
        <>
          <div className="menu-sep" />
          {splitModes.map((m) => (
            <button
              key={m}
              className="menu-item"
              role="menuitem"
              {...tip(`split into ${m}`, { does: `replace this text with one text clip per ${m.slice(0, -1)}, each where it is now`, side: 'right' })}
              onClick={run(() => splitText(clip.id, m))}
            >
              <Type size={14} />
              {`split into ${m}`}
            </button>
          ))}
        </>
      ) : null}
      {swaps.length > 0 ? (
        <>
          <div className="menu-sep" />
          <div className="menu-hint" aria-hidden="true">
            swap media
          </div>
          {swaps.map((a) => (
            <button
              key={a.id}
              className="menu-item"
              role="menuitem"
              {...tip(a.name, { does: `replace this clip's media with ${a.name}`, side: 'right' })}
              onClick={run(() => {
                if (!useEditor.getState().replaceClipAsset(clip.id, a.id)) useUi.getState().toast('could not swap the media');
              })}
            >
              <Replace size={14} />
              <span className="timeline-menu-asset">{a.name}</span>
            </button>
          ))}
        </>
      ) : null}
      {seqIds.length > 1 ? (
        <>
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            {...tip('in a row', { does: 'lay the selected clips end to end on one track', side: 'right' })}
            onClick={run(() => makeRow(ids))}
          >
            <AlignHorizontalJustifyStart size={14} />
            in a row
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!hasMarkers}
            {...tip('fit to the markers', { does: 'lay the clips end to end, each one from a marker to the next', side: 'right', off: hasMarkers ? null : REASON_TEXT.noMarkers })}
            onClick={run(() => fitToMarkers(ids, 1))}
          >
            <Flag size={14} />
            fit to the markers
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!hasMarkers}
            {...tip('fit to every 2nd marker', { does: 'like fit to the markers, each clip spans 2 markers', side: 'right', off: hasMarkers ? null : REASON_TEXT.noMarkers })}
            onClick={run(() => fitToMarkers(ids, 2))}
          >
            <Flag size={14} />
            fit to every 2nd marker
          </button>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!hasMarkers}
            {...tip('fit to every 4th marker', { does: 'like fit to the markers, each clip spans 4 markers', side: 'right', off: hasMarkers ? null : REASON_TEXT.noMarkers })}
            onClick={run(() => fitToMarkers(ids, 4))}
          >
            <Flag size={14} />
            fit to every 4th marker
          </button>
        </>
      ) : null}
      {effectsHere.length > 0 || targetedEffects.length > 0 ? <div className="menu-sep" /> : null}
      {effectsHere.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('select its effects', { does: 'select the effects that are put on this clip', side: 'right' })}
          onClick={run(() => selectEffectsOf(visual.map((c) => c.id)))}
        >
          <Sparkles size={14} />
          select its effects
        </button>
      ) : null}
      {targetedEffects.length > 0 ? (
        <>
          <button
            className="menu-item"
            role="menuitem"
            disabled={!targetClip}
            {...tip('go to its clip', { does: 'select the clip this effect is on and show it', side: 'right', off: targetClip ? null : 'the clip this effect was on is gone' })}
            onClick={run(() => goToEffectTarget(clip.id))}
          >
            <Target size={14} />
            go to its clip
          </button>
          <button
            className="menu-item"
            role="menuitem"
            {...tip(allOwn ? 'key the clip under it' : 'apply to everything below', {
              does: allOwn ? 'make the selected chroma keys key the video or picture right under them' : 'make the selected effects change everything below their track again',
              side: 'right',
            })}
            onClick={run(() => applyEffectsToEverything(picked.map((c) => c.id)))}
          >
            <Layers size={14} />
            {allOwn ? 'key the clip under it' : 'apply to everything below'}
          </button>
        </>
      ) : null}
      {withTransition.length > 0 || withKeys.length > 0 || visual.length > 0 ? <div className="menu-sep" /> : null}
      {withTransition.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('remove transition', { does: 'remove the transition from the selected clips', side: 'right' })}
          onClick={run(() => {
            const st = useEditor.getState();
            st.pushHistory();
            for (const c of withTransition) st.updateClip(c.id, { transition: null }, { skipHistory: true });
          })}
        >
          <Blend size={14} />
          remove transition
        </button>
      ) : null}
      {withKeys.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip('clear keyframes', { does: 'clear every keyframe of the selected clips (values stay as they are at the playhead)', side: 'right' })}
          onClick={run(() => clearKeysOf(withKeys.map((c) => c.id)))}
        >
          <Diamond size={14} />
          clear keyframes
        </button>
      ) : null}
      {visual.length > 0 ? (
        <button
          className="menu-item"
          role="menuitem"
          {...tip(is3d ? 'make 2d' : 'make 3d', {
            does: is3d ? 'make the selected clips flat 2d again' : 'place the selected clips in 3d space',
            side: 'right',
            keys: 'toggle-3d',
          })}
          onClick={run(() => {
            const st = useEditor.getState();
            st.pushHistory();
            for (const c of visual) st.updateClip(c.id, { threeD: !is3d }, { skipHistory: true });
          })}
        >
          {is3d ? <Square size={14} /> : <Box size={14} />}
          {is3d ? 'make 2d' : 'make 3d'}
          <MenuKeys id="toggle-3d" />
        </button>
      ) : null}
      <CrossfadeClipItems clipId={clipId} ids={ids} onDone={onClose} />
      {timed ? (
        <>
          <div className="menu-sep" />
          <button
            className="menu-item"
            role="menuitem"
            {...tip(muted ? 'unmute' : 'mute', { does: muted ? 'unmute the clip audio' : 'mute the clip audio', side: 'right', keys: 'mute' })}
            onClick={run(() => {
              const st = useEditor.getState();
              const next = !muted;
              st.pushHistory();
              for (const c of muteTargets(st.project?.clips ?? [], ids)) {
                useEditor.getState().updateClip(c.id, { muted: next }, { skipHistory: true });
              }
            })}
          >
            {muted ? <Volume2 size={14} /> : <VolumeX size={14} />}
            {muted ? 'unmute' : 'mute'}
            <MenuKeys id="mute" />
          </button>
        </>
      ) : null}
      {sounds ? (
        <>
          <div className="menu-sep" />
          <div className="menu-hint" aria-hidden="true">
            beats
          </div>
          <button
            className="menu-item"
            role="menuitem"
            {...tip('mark every beat', { does: 'put a marker on every beat of this clip', side: 'right' })}
            onClick={run(() => void markBeats(clip.id, 1))}
          >
            <AudioLines size={14} />
            mark every beat
          </button>
          <button
            className="menu-item"
            role="menuitem"
            {...tip('mark every 2nd beat', { does: 'put a marker on every 2nd beat', side: 'right' })}
            onClick={run(() => void markBeats(clip.id, 2))}
          >
            <AudioLines size={14} />
            mark every 2nd beat
          </button>
          <button
            className="menu-item"
            role="menuitem"
            {...tip('mark every 4th beat', { does: 'put a marker on every 4th beat (bars)', side: 'right' })}
            onClick={run(() => void markBeats(clip.id, 4))}
          >
            <AudioLines size={14} />
            mark every 4th beat
          </button>
          <button
            className="menu-item"
            role="menuitem"
            {...tip('clear beat markers', { does: 'remove the beat markers inside this clip', side: 'right' })}
            onClick={run(() => void clearBeatMarkers(clip.id))}
          >
            <Trash2 size={14} />
            clear beat markers
          </button>
        </>
      ) : null}
    </div>
  );
}
