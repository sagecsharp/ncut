import { memo, useCallback, useMemo } from 'react';
import { Link2Off, Ungroup } from 'lucide-react';
import { childrenOf, parentOf } from '../../lib/links';
import { useEditor } from '../../store/editorStore';
import type { Clip } from '../../types';
import { isVisualClip } from '../../types';
import { Row, Section, useSelectOpen } from './controls';
import { attachClips } from './attachActions';
import { hasAnimatedPose, parentOptions } from './parentOptions';
import type { ParentOption } from './parentOptions';
import { closedModel, currentLabel, openModel } from './selectModel';

const actions = () => useEditor.getState();

/**
 * "nothing" + the clips a parent can be, the ones on screen at the same time first.
 * the list is only built and rendered while the select is open (touched, focused or typed into); closed, it holds
 * the one selected choice with the same text. `current` is the label of the selected clip (selectModel.currentLabel),
 * null when it is not one of the choices ("missing clip"). `build` makes the full list from the clips and should be
 * stable (useCallback).
 */
export function ParentSelect({
  label,
  title,
  value,
  current,
  build,
  onPick,
  noneLabel = 'nothing',
}: {
  label: string;
  title: string;
  /** a clip id, '' for nothing, or null when the clips differ */
  value: string | null;
  current: string | null;
  build: (clips: readonly Clip[]) => ParentOption[];
  onPick: (id: string | null) => void;
  /** text of the empty choice */
  noneLabel?: string;
}) {
  const { open, handlers } = useSelectOpen();
  // subscribed to the clips only while the list is shown
  const clips = useEditor((s) => (open ? s.project?.clips : undefined));
  const options = useMemo(() => (open && clips ? build(clips) : null), [open, clips, build]);
  const model = options ? openModel(value, options, noneLabel) : closedModel(value, current, noneLabel);
  return (
    <Row label={label} title={title}>
      <select
        className="select"
        title={title}
        aria-label={title}
        value={model.selected}
        onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
        {...handlers}
      >
        {model.head.map((h) => (
          <option key={h.value} value={h.value} disabled={h.disabled}>
            {h.label}
          </option>
        ))}
        {model.near.length > 0 ? (
          <optgroup label="at the same time">
            {model.near.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {model.far.length > 0 ? (
          <optgroup label="other times">
            {model.far.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
    </Row>
  );
}

/** attach to / attached clips / group line of one clip. renders nothing when there is nothing to show. */
export const LinksSection = memo(function LinksSection({ clip }: { clip: Clip }) {
  const clips = useEditor((s) => s.project?.clips);
  const visual = isVisualClip(clip);
  const id = clip.id;
  const info = useMemo(() => {
    if (!clips) return null;
    const project = { clips };
    const parent = visual ? parentOf(project, clip) : null;
    return {
      // the label of the clip it is attached to, from the full list (only when attached: a closed picker needs no list)
      parentLabel: parent ? currentLabel(parentOptions(project, [id]), parent.id) : null,
      parent,
      children: visual || clip.type === 'camera' ? childrenOf(project, id) : [],
      groupSize: clip.group ? clips.filter((c) => c.group === clip.group).length : 0,
    };
  }, [clips, clip, id, visual]);
  const build = useCallback((all: readonly Clip[]) => parentOptions({ clips: all }, [id]), [id]);
  if (!info) return null;
  const { parentLabel, parent, children, groupSize } = info;
  if (!visual && children.length === 0 && groupSize < 2) return null;
  const parentName = parent ? (parentLabel ?? parent.name) : '';

  return (
    <Section id="attach" title="attach">
      {visual ? (
        <>
          <ParentSelect
            label="attach to"
            title="follow another clip or a camera: it moves, turns and scales with it"
            value={parent ? parent.id : ''}
            current={parentLabel}
            build={build}
            onPick={(pid) => attachClips([id], pid)}
          />
          {parent ? (
            <div className="props-stat">
              <button type="button" className="btn btn-sm" title="select the clip this one is attached to" onClick={() => actions().select([parent.id])}>
                {parentName}
              </button>
              <button type="button" className="btn btn-sm" title="detach from it, the clip stays where it is" onClick={() => attachClips([id], null)}>
                <Link2Off size={14} />
                detach
              </button>
            </div>
          ) : null}
          {parent && hasAnimatedPose(clip) ? (
            <div className="props-hint">animated values now move relative to the new parent</div>
          ) : null}
        </>
      ) : null}
      {children.length > 0 ? (
        <div className="props-stat">
          <span className="props-hint">
            {children.length} {children.length === 1 ? 'clip' : 'clips'} attached
          </span>
          <button
            type="button"
            className="btn btn-sm"
            title="select the clips attached to this one"
            onClick={() => actions().select(children.map((c) => c.id))}
          >
            select them
          </button>
        </div>
      ) : null}
      {groupSize >= 2 ? (
        <div className="props-stat">
          <span className="props-hint">in a group of {groupSize}</span>
          <button type="button" className="btn btn-sm" title="split the group, the clips stay as they are" onClick={() => actions().ungroupClips([id])}>
            <Ungroup size={14} />
            ungroup
          </button>
        </div>
      ) : null}
    </Section>
  );
});
