/** the three point edit row under the source transport */
import { memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { ArrowDownToLine, BetweenVerticalStart, ListEnd, Replace, UnfoldHorizontal } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { useSource } from '../../store/source';
import { editNow } from '../timeline/editActions';
import { editSummary } from '../timeline/editPlan';
import type { EditMode } from '../timeline/editPlan';
import { useTargets } from '../timeline/editTargets';
import { useSoundApart } from '../timeline/soundSetting';
import { tip } from '../shell/tip';
import './sourceEdits.css';

const ICON = 14;

function EditButton({ mode, name, Icon, ...rest }: { mode: EditMode; name: string; Icon: LucideIcon } & ReturnType<typeof tip>) {
  return (
    <button type="button" className="btn btn-ghost btn-sm source-edit" aria-label={name} onClick={() => editNow(mode)} {...rest}>
      <Icon size={ICON} />
      <span className="source-edit-label">{name}</span>
    </button>
  );
}

const SourceEditRow = memo(function SourceEditRow({ assetId }: { assetId: string }) {
  const targets = useTargets();
  const apart = useSoundApart((s) => s.apart);
  const sum = useEditor(useShallow((s) => editSummary(s.project, assetId, targets, apart)));
  return (
    <div className="source-edit-row" role="group" aria-label="edit into the timeline">
      <EditButton
        mode="insert" name="insert" Icon={BetweenVerticalStart}
        {...tip('insert', { does: 'the marked part goes in at the in point or the playhead. the clips after it move later on every unlocked track', keys: 'insert-edit', why: 'insert-edit' })}
      />
      <EditButton
        mode="overwrite" name="overwrite" Icon={ArrowDownToLine}
        {...tip('overwrite', { does: 'the marked part covers what is on the target tracks. nothing moves', keys: 'overwrite-edit', why: 'overwrite-edit' })}
      />
      <EditButton
        mode="replace" name="replace" Icon={Replace}
        {...tip('replace', { does: 'the clip under the playhead shows this media instead, this frame at the playhead. its length, look and keys stay', why: 'replace-edit' })}
      />
      <EditButton
        mode="fit" name="fit to the range" Icon={UnfoldHorizontal}
        {...tip('fit to the range', { does: sum?.fit ?? 'the marked part fills the in to out range of the timeline: its speed changes to fit', why: 'fit-edit' })}
      />
      <EditButton
        mode="append" name="append" Icon={ListEnd}
        {...tip('append', { does: 'the marked part goes after the last clip of the target tracks', why: 'append-edit' })}
      />
      <span className={`source-edit-plan${sum?.blocked ? ' is-blocked' : ''}`}>{sum?.text ?? ''}</span>
    </div>
  );
});

export function SourceEdits() {
  const assetId = useSource((s) => s.assetId);
  return assetId ? <SourceEditRow assetId={assetId} /> : null;
}
