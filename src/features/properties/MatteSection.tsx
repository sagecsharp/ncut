import { memo, useCallback } from 'react';
import { MATTE_MODES, MATTE_MODE_LABELS, MATTE_TEXT, matteField, matteHint, matteState, matteUserIds, planMatteRelease } from '../../engine/matte';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { Clip, MatteMode, VisualClip } from '../../types';
import { clipDisplayName } from '../timeline/effectTarget';
import { tip } from '../shell/tip';
import { ParentSelect } from './AttachSection';
import { Row, Section } from './controls';
import { matteAbove, releaseMatte, selectMatteOther, setMatte, setMatteMode } from './matteActions';
import { matteClipOptions } from './parentOptions';
import { currentLabel } from './selectModel';

const toast = (t: string) => useUi.getState().toast(t);

/** "matte": cut this clip with another picture clip, by its outline or its brightness. only primitives are subscribed. */
export const MatteSection = memo(function MatteSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const m = matteField(clip);
  const mc = m?.clip;
  const state = useEditor((s) => (s.project ? matteState(s.project, id) : 'none'));
  const name = useEditor((s) => {
    const c = mc ? s.project?.clips.find((k) => k.id === mc) : undefined;
    return c ? clipDisplayName(c) : null;
  });
  const isSource = useEditor((s) => (s.project ? matteUserIds(s.project.clips, id).length > 0 : false));
  const locked = useEditor((s) => s.project?.tracks.find((t) => t.id === clip.trackId)?.locked ?? false);
  const current = useEditor((s) => (mc && s.project ? currentLabel(matteClipOptions(s.project, id, mc), mc) : null));
  const build = useCallback((clips: readonly Clip[]) => matteClipOptions({ clips }, id, mc), [id, mc]);
  const onPick = useCallback((src: string | null) => setMatte(id, src), [id]);
  if (isSource) {
    return (
      <Section id="matte" title="matte">
        <div className="props-stat">
          <span className="props-hint">this clip is the matte of another clip: a matte clip cannot have a matte of its own</span>
        </div>
      </Section>
    );
  }
  const off = locked ? MATTE_TEXT.trackLocked : null;
  return (
    <Section id="matte" title="matte">
      {locked ? (
        <span className="props-hint">{MATTE_TEXT.trackLocked}</span>
      ) : (
        <ParentSelect
          label="matte"
          title="the clip that cuts this one. it is not drawn on its own"
          value={mc ?? ''}
          current={current}
          build={build}
          onPick={onPick}
          noneLabel="no matte"
        />
      )}
      {m ? (
        <Row label="use" title="what of the matte clip counts">
          <select
            className="select"
            title="what of the matte clip counts"
            aria-label="matte mode"
            value={m.mode}
            disabled={locked}
            onChange={(e) => setMatteMode(id, e.target.value as MatteMode)}
          >
            {MATTE_MODES.map((v) => (
              <option key={v} value={v}>
                {MATTE_MODE_LABELS[v]}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
      <div className="props-stat">
        <span className="props-hint">{matteHint(state, m?.mode ?? 'alpha', name ?? '', !!clip.threeD)}</span>
      </div>
      <div className="props-buttons">
        {!m ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            {...tip('use clip above', { does: 'the picture clip on the nearest track above, at the same time, becomes the matte', off })}
            onClick={() => toast(matteAbove([id]))}
          >
            use clip above
          </button>
        ) : null}
        {m && name !== null ? (
          <button
            type="button"
            className="btn btn-sm"
            {...tip('select matte clip', { does: 'select the matte clip to move or change it. its box shows on the preview' })}
            onClick={() => {
              const t = selectMatteOther([id]);
              if (t) toast(t);
            }}
          >
            select matte clip
          </button>
        ) : null}
        {m ? (
          <button
            type="button"
            className="btn btn-sm"
            disabled={locked}
            {...tip('remove', { does: 'remove the matte: the clip shows in full', off })}
            onClick={() => setMatte(id, null)}
          >
            remove
          </button>
        ) : null}
      </div>
    </Section>
  );
});

/** on the inspector of a clip that is the matte of others: whose, and a way to select them or take the matte off */
export const MatteSourceNote = memo(function MatteSourceNote({ id }: { id: string }) {
  const names = useEditor((s) => {
    if (!s.project) return null;
    const users = matteUserIds(s.project.clips, id);
    if (users.length === 0) return null;
    return users.map((u) => clipDisplayName(s.project!.clips.find((c) => c.id === u)!)).join(', ');
  });
  // every clip it is the matte of sits on a locked track: nothing can be taken off
  const stuck = useEditor((s) => (s.project ? planMatteRelease(s.project, id).length === 0 : true));
  if (!names) return null;
  return (
    <div className="props-stat">
      <span className="props-hint">the matte of {names}. not drawn on its own.</span>
      <button
        type="button"
        className="btn btn-sm"
        {...tip('select them', { does: 'select the clips this one is the matte of' })}
        onClick={() => {
          const t = selectMatteOther([id]);
          if (t) toast(t);
        }}
      >
        select them
      </button>
      <button
        type="button"
        className="btn btn-sm"
        disabled={stuck}
        {...tip('take off', { does: 'take this matte off those clips: this clip is drawn again', off: stuck ? 'the tracks of those clips are locked' : null })}
        onClick={() => toast(releaseMatte(id))}
      >
        take off
      </button>
    </div>
  );
});
