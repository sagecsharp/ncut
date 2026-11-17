import { memo, useMemo, useRef, useState } from 'react';
import { Diamond, RotateCcw, Spline } from 'lucide-react';
import { percentOf, roundShown } from '../../components/ui/numberFormat';
import { hasBend } from '../../engine/scene3d/bend';
import { knownShape } from '../../engine/scene3d/meshes';
import { evalKeys, keyIndexAt } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { isVisualClip } from '../../types';
import type { BendAlong, Easing, VisualClip } from '../../types';
import { FieldView, AnimField, easeKeyIndex, inClip } from './AnimField';
import { bendAlone, bendEach, bendLeader, bendMates, bendTargets, bendTogether, flattenBends, matchBendKeys } from './bendActions';
import { bendMembers, bendState } from './bendGroup';
import type { BendState } from './bendGroup';
import { Row, Section, SliderRow } from './controls';
import { beginEdit, liveOpts } from './edit';
import { useFeelCtx } from './feelContext';
import { feelOf } from './fieldFeel';

const actions = () => useEditor.getState();

const ALONG_TITLE = 'which edges bend round';
const WIDTH_TITLE = 'the left and right edges bend round, like a cinema screen';
const HEIGHT_TITLE = 'the top and bottom edges bend round, like a rolled page';

/** the playhead, read now (never subscribed: nothing here follows it per frame) */
const now = (): number => usePlayback.getState().time;

/** the two buttons "width" and "height" of an along row */
function AlongButtons({ value, onPick }: { value: BendAlong; onPick(along: BendAlong): void }) {
  return (
    <div className="props-seg">
      <button type="button" className={`btn btn-sm${value === 'width' ? ' is-active' : ''}`} aria-pressed={value === 'width'} title={WIDTH_TITLE} onClick={() => onPick('width')}>
        width
      </button>
      <button type="button" className={`btn btn-sm${value === 'height' ? ' is-active' : ''}`} aria-pressed={value === 'height'} title={HEIGHT_TITLE} onClick={() => onPick('height')}>
        height
      </button>
    </div>
  );
}

/** the bend angle of several clips: the leader's value and keys, written through bendTogether / bendEach. a drag is one undo step */
export function GroupBendField(p: { ids: readonly string[]; how: 'one' | 'each'; title: string; label?: string }) {
  const leader = useEditor((s) => bendLeader(s.project, p.ids));
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const ctx = useFeelCtx();
  const t0 = useRef(0);
  const feel = feelOf('bendAngle', ctx);
  const keys = leader?.keyframes?.['bend.angle'] ?? [];
  const start = leader?.start ?? 0;
  const duration = leader?.duration ?? 0;
  const tol = 0.5 / fps;
  const local = (t: number): number => clamp(t, start, start + duration) - start;
  const keyed = keys.length > 0;
  const plain = leader?.bend?.angle ?? 0;

  // the same subscriptions as AnimField's AnimatedBody: they return what is shown, so a frame that changes nothing renders nothing
  const value = usePlayback((s) => roundShown((keyed ? evalKeys(keys, local(s.time), leader ?? undefined, 'bend.angle') : plain) * feel.scale, feel.precision));
  const keyHere = usePlayback((s) => keyed && keyIndexAt(keys, local(s.time), tol) >= 0);
  const hasPrev = usePlayback((s) => keyed && keys.some((k) => inClip(k, duration) && k.t < local(s.time) - tol));
  const hasNext = usePlayback((s) => keyed && keys.some((k) => inClip(k, duration) && k.t > local(s.time) + tol));
  const ease = usePlayback((s): Easing => (keyed ? keys[easeKeyIndex(keys, local(s.time), tol)]!.ease : 'ease'));
  if (!leader) return null;
  const id = leader.id;
  const run = (change: Parameters<typeof bendTogether>[1], time: number, opts: Parameters<typeof bendTogether>[3]) =>
    p.how === 'one' ? bendTogether(p.ids, change, time, opts) : bendEach(p.ids, change, time, opts);

  const onPress = () => {
    const pb = usePlayback.getState();
    if (keyed && pb.playing) pb.pause();
  };
  return (
    <FieldView
      label={p.label ?? 'bend'}
      title={p.title}
      feel={feel}
      value={value}
      animated={keyed}
      keyHere={keyHere}
      hasPrev={hasPrev}
      hasNext={hasNext}
      ease={ease}
      onPress={onPress}
      onStart={() => {
        onPress();
        // not clamped: the members start at different times and the write takes a timeline time
        t0.current = now();
        beginEdit();
      }}
      onValue={(v) => {
        run({ angle: v }, t0.current, liveOpts());
        const c = actions().project?.clips.find((x) => x.id === id);
        if (!c) return v;
        const ks = c.keyframes?.['bend.angle'];
        const at = clamp(t0.current, c.start, c.start + c.duration);
        return ks && ks.length > 0 ? evalKeys(ks, at - c.start, c, 'bend.angle') : (isVisualClip(c) ? (c.bend?.angle ?? v) : v);
      }}
      onToggle={() => {
        run({ key: 'toggle' }, now(), {});
      }}
      onJump={(dir) => {
        const l = local(now());
        const target = dir < 0 ? [...keys].reverse().find((k) => inClip(k, duration) && k.t < l - tol) : keys.find((k) => inClip(k, duration) && k.t > l + tol);
        if (target) usePlayback.getState().seek(start + target.t);
      }}
      onEase={(e) => {
        const key = keys[easeKeyIndex(keys, local(now()), tol)];
        if (!key) return;
        const st = actions();
        st.pushHistory();
        st.setKeyframe(id, 'bend.angle', start + key.t, undefined, e, { skipHistory: true });
        if (p.how === 'one') matchBendKeys(p.ids, { skipHistory: true });
      }}
    />
  );
}

interface Info {
  clips: VisualClip[];
  solids: number;
  state: BendState;
  bent: boolean;
  exact: boolean;
  /** exactly one group, every clip of it bent as one (a span set): the same bend the single clip section shows */
  joined: boolean;
  mixed: boolean;
}

/** what the rows and hints of a group of clips need to know, read when the project changes */
function useInfo(ids: readonly string[]): Info | null {
  const project = useEditor((s) => s.project);
  const key = ids.join('|');
  return useMemo(() => {
    if (!project) return null;
    const { clips, solids } = bendTargets(project, ids);
    const time = now();
    // many flat clips: nothing to measure, so the group state is the empty one
    const bent = clips.some((c) => hasBend(c));
    const none: BendState = { together: false, off: [], keysApart: false, onePlane: false, middle: 0 };
    const state = clips.some((c) => c.bend || (c.keyframes?.['bend.angle']?.length ?? 0) > 0) ? bendState(bendMembers(project, clips, time), clips, time) : none;
    const g0 = clips[0]?.group;
    const inIds = new Set(clips.map((c) => c.id));
    const exact =
      !!g0 &&
      clips.every((c) => c.group === g0) &&
      bendTargets(
        project,
        project.clips.filter((c) => c.group === g0 && !inIds.has(c.id)).map((c) => c.id),
      ).clips.length === 0;
    return {
      clips,
      solids: solids.length,
      state,
      bent,
      exact,
      joined: exact && clips.every((c) => typeof c.bend?.span === 'number' && c.bend.span > 0),
      mixed: clips.some((c) => c.threeD) && clips.some((c) => !c.threeD),
    };
    // ids is read through its joined key
  }, [project, key]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * the rows of a group bend. `mates` is set when this is one clip of a bend it shares with others (the single clip
 * section): then it is always bent as one, with no "how" row.
 */
function GroupBody({ ids, mates }: { ids: readonly string[]; mates?: number }) {
  const info = useInfo(ids);
  // the start value is worked out once per set of ids, so a drag or a move never flips it
  const key = ids.join('|');
  const [pick, setPick] = useState<{ key: string; how: 'one' | 'each' | null }>({ key, how: null });
  if (!info) return null;
  const { state } = info;
  let chosen = pick.how;
  if (pick.key !== key || chosen === null) {
    chosen = info.bent && !state.together && !info.joined ? 'each' : 'one';
    setPick({ key, how: chosen });
  }
  // below two bendable clips there is nothing to bend as one
  const single = info.clips.length < 2;
  const how: 'one' | 'each' = mates !== undefined && !single ? 'one' : single ? 'each' : chosen;
  const setHow = (h: 'one' | 'each') => setPick({ key, how: h });
  const lead = info.clips[0];
  const along: BendAlong = lead?.bend?.along === 'height' ? 'height' : 'width';
  const setAlong = (a: BendAlong) => {
    if (how === 'one') bendTogether(ids, { along: a }, now(), {});
    else bendEach(ids, { along: a }, now(), {});
  };
  const flatTitle = mates !== undefined ? 'take the bend off this clip and the clips bent with it, keyframes too' : 'take the bend off the selected clips, keyframes too';
  return (
    <>
      {mates !== undefined ? (
        <div className="props-hint">
          bent together with {mates} other {mates === 1 ? 'clip' : 'clips'}. a change here changes all of them.
        </div>
      ) : null}
      {info.solids > 0 ? (
        <div className="props-hint">
          {info.solids === 1 ? '1 clip has a 3d shape other than plane and stays as it is.' : `${info.solids} clips have a 3d shape other than plane and stay as they are.`}
        </div>
      ) : null}
      {mates === undefined && !single ? (
        <Row label="how" title="one bend through all the clips, or each on its own">
          <div className="props-seg">
            <button
              type="button"
              className={`btn btn-sm${how === 'one' ? ' is-active' : ''}`}
              aria-pressed={how === 'one'}
              title="one bend through all the clips: the outer ones come forward or go back, each bends by its share"
              onClick={() => setHow('one')}
            >
              as one
            </button>
            <button
              type="button"
              className={`btn btn-sm${how === 'each' ? ' is-active' : ''}`}
              aria-pressed={how === 'each'}
              title="every clip bends around its own middle"
              onClick={() => setHow('each')}
            >
              each
            </button>
          </div>
        </Row>
      ) : null}
      <GroupBendField ids={ids} how={how} title="how far the selected clips bend (deg), as one surface or each on its own. 360 closes a row into a ring" />
      <Row label="along" title={ALONG_TITLE}>
        <AlongButtons value={along} onPick={setAlong} />
      </Row>
      {how === 'one' ? (
        <SliderRow
          label="flat at"
          feel="bendMiddle"
          title="where the row stays flat and in place (% of the whole row). 0 = its middle, -50 or 50 = an end"
          value={percentOf(state.middle)}
          onChange={(v) => {
            bendTogether(ids, { middle: v / 100 }, now(), liveOpts());
          }}
        />
      ) : null}
      <div className="props-buttons">
        {how === 'one' ? (
          <button
            type="button"
            className="btn btn-sm"
            title="lay the bend over the clips where they are now, after you moved, added or resized some"
            onClick={() => bendTogether(ids, { fit: true }, now(), {})}
          >
            <Spline size={14} />
            fit again
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" title={flatTitle} onClick={() => flattenBends(ids, {})}>
          <RotateCcw size={14} />
          flat
        </button>
        {mates !== undefined && ids[0] ? (
          <button
            type="button"
            className="btn btn-sm"
            title="leave the shared bend. this clip keeps how much it bends, around its own middle"
            onClick={() => bendAlone(ids[0]!, now(), {})}
          >
            bend on its own
          </button>
        ) : null}
      </div>
      {how === 'one' && !info.exact ? <div className="props-hint">bending them as one also groups them, so they move together.</div> : null}
      {how === 'one' && info.bent && state.off.length > 0 ? <div className="props-hint">some clips moved or were added since the bend. fit again to join them up.</div> : null}
      {how === 'one' && info.bent && !state.onePlane ? <div className="props-hint">these clips do not face the same way in one plane, so they bend but do not join up.</div> : null}
      {state.keysApart ? (
        <div className="props-stat">
          <span className="props-hint">the clips have different bend keyframes.</span>
          <button type="button" className="btn btn-sm" title="give every clip the bend keyframes of the first one" onClick={() => matchBendKeys(ids, {})}>
            <Diamond size={14} />
            match
          </button>
        </div>
      ) : null}
      {how === 'one' && info.mixed ? <div className="props-hint">2d clips bend seen from the front, so they only line up with the 3d ones while the camera is at home.</div> : null}
    </>
  );
}

/** the bend of several picture clips (no Section around it: the multi inspector wraps it) */
export function MultiBendSection({ ids }: { ids: readonly string[] }) {
  return <GroupBody ids={ids} />;
}

/** the bend of one picture clip: a plain bend, or the shared bend when other clips are bent with it */
export const BendSection = memo(function BendSection({ clip }: { clip: VisualClip }) {
  const project = useEditor((s) => s.project);
  const mates = useMemo(() => (project ? bendMates(project, clip) : []), [project, clip]);
  const ids = useMemo(() => [clip.id, ...mates.map((c) => c.id)], [clip.id, mates]);
  const solid = !!clip.threeD && knownShape(clip.shape) !== 'plane';
  const id = clip.id;
  const along: BendAlong = clip.bend?.along === 'height' ? 'height' : 'width';
  const body = () => {
    if (solid) return <div className="props-hint">only a plane bends. set shape to plane in 3d first.</div>;
    if (mates.length > 0) return <GroupBody ids={ids} mates={mates.length} />;
    return (
      <>
        <AnimField
          id={id}
          prop="bend.angle"
          label="bend"
          feel="bendAngle"
          title="how far the clip bends (deg). + brings the edges toward you, - pushes them away. 360 rolls it into a tube"
        />
        <Row label="along" title={ALONG_TITLE}>
          <AlongButtons value={along} onPick={(a) => actions().updateClip(id, { bend: { ...(clip.bend ?? { angle: 0 }), along: a } })} />
        </Row>
        <SliderRow
          label="flat at"
          feel="bendCenter"
          title="where the clip stays flat and in place (% of its length from the middle). -50 or 50 = an edge: it rolls up from the other side"
          value={percentOf(clip.bend?.center ?? 0)}
          onChange={(v) => {
            const cur = actions().project?.clips.find((c) => c.id === id);
            const bend = cur && isVisualClip(cur) ? cur.bend : undefined;
            actions().updateClip(id, { bend: { ...(bend ?? { angle: 0 }), center: v / 100 } }, liveOpts());
          }}
        />
        {typeof clip.bend?.span === 'number' && clip.bend.span > 0 ? (
          <div className="props-hint">the bend is measured over the row this clip was bent with, so 360 does not close it into a tube.</div>
        ) : null}
        <div className="props-buttons">
          {typeof clip.bend?.span === 'number' && clip.bend.span > 0 ? (
            <button type="button" className="btn btn-sm" title="leave the row it was bent with. the clip keeps how much it bends, around its own middle" onClick={() => bendAlone(id, now(), {})}>
              bend on its own
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm"
            title="take the bend off, its keyframes too"
            disabled={!clip.bend && !(clip.keyframes?.['bend.angle']?.length ?? 0)}
            onClick={() => actions().setBends([{ id, bend: null, keys: null }])}
          >
            <RotateCcw size={14} />
            flat
          </button>
        </div>
        {!clip.threeD && hasBend(clip) ? <div className="props-hint">a 2d clip bends in place, seen from the front. turn on 3d to see it from the side.</div> : null}
      </>
    );
  };
  return (
    <Section id="bend" title="bend">
      {body()}
    </Section>
  );
});
