import { memo, useMemo } from 'react';
import { Link2Off, Ungroup } from 'lucide-react';
import { childrenOf, parentOf } from '../../lib/links';
import { useEditor } from '../../store/editorStore';
import type { Clip } from '../../types';
import { isVisualClip } from '../../types';
import { Row, Section } from './controls';
import { attachClips } from './attachActions';
import { hasAnimatedPose, parentOptions } from './parentOptions';
import type { ParentOption } from './parentOptions';

const actions = () => useEditor.getState();

/** "nothing" + the clips a parent can be, the ones on screen at the same time first */
export function ParentSelect({
  label,
  title,
  value,
  options,
  onPick,
  noneLabel = 'nothing',
}: {
  label: string;
  title: string;
  /** a clip id, '' for nothing, or null when the clips differ */
  value: string | null;
  options: ParentOption[];
  onPick: (id: string | null) => void;
  /** text of the empty choice */
  noneLabel?: string;
}) {
  const near = options.filter((o) => o.overlaps);
  const far = options.filter((o) => !o.overlaps);
  const known = value === null || value === '' || options.some((o) => o.id === value);
  return (
    <Row label={label} title={title}>
      <select
        className="select"
        title={title}
        aria-label={title}
        value={value ?? '__mixed'}
        onChange={(e) => onPick(e.target.value === '' ? null : e.target.value)}
      >
        {value === null ? (
          <option value="__mixed" disabled>
            various
          </option>
        ) : null}
        <option value="">{noneLabel}</option>
        {!known ? <option value={value}>missing clip</option> : null}
        {near.length > 0 ? (
          <optgroup label="at the same time">
            {near.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </optgroup>
        ) : null}
        {far.length > 0 ? (
          <optgroup label="other times">
            {far.map((o) => (
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
      options: visual ? parentOptions(project, [id]) : [],
      parent,
      children: visual || clip.type === 'camera' ? childrenOf(project, id) : [],
      groupSize: clip.group ? clips.filter((c) => c.group === clip.group).length : 0,
    };
  }, [clips, clip, id, visual]);
  if (!info) return null;
  const { options, parent, children, groupSize } = info;
  if (!visual && children.length === 0 && groupSize < 2) return null;
  const parentName = parent ? (options.find((o) => o.id === parent.id)?.label ?? parent.name) : '';

  return (
    <Section id="attach" title="attach">
      {visual ? (
        <>
          <ParentSelect
            label="attach to"
            title="follow another clip or a camera: it moves, turns and scales with it"
            value={parent ? parent.id : ''}
            options={options}
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
