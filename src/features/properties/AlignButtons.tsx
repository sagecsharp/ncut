import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalSpaceBetween,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalSpaceBetween,
} from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { alignSelection, spreadSelection } from './alignActions';
import type { AlignKind } from './alignLogic';
import { Row } from './controls';
import { alignCounts } from './selectionSets';

const KINDS: { kind: AlignKind; icon: typeof AlignStartVertical; one: string; many: string }[] = [
  { kind: 'left', icon: AlignStartVertical, one: 'align left', many: 'align left edges' },
  { kind: 'center', icon: AlignCenterVertical, one: 'align center', many: 'align horizontal centers' },
  { kind: 'right', icon: AlignEndVertical, one: 'align right', many: 'align right edges' },
  { kind: 'top', icon: AlignStartHorizontal, one: 'align top', many: 'align top edges' },
  { kind: 'middle', icon: AlignCenterHorizontal, one: 'align middle', many: 'align vertical centers' },
  { kind: 'bottom', icon: AlignEndHorizontal, one: 'align bottom', many: 'align bottom edges' },
];

/**
 * six align buttons. one clip: to the canvas. several: to the bounds of the selection, plus spread out
 * evenly for 3 or more. 3d clips, attached clips and clips on locked tracks are left out (their x / y does
 * not map to the canvas one to one), and the hint says so.
 */
export const AlignButtons = memo(function AlignButtons({ ids }: { ids: string[] }) {
  // two numbers out of the store: the buttons re-render when they change, not on every clip edit or drag frame
  const want = useMemo(() => new Set(ids), [ids]);
  const { usable, visual } = useEditor(useShallow((s) => alignCounts(s.project, want)));
  const many = ids.length > 1;
  const need = many ? 2 : 1;
  const off = usable < need;
  const to = many ? 'selection' : 'canvas';

  return (
    <>
      <Row label="align" title={many ? 'line the selected clips up with each other' : 'line the clip up with the canvas'}>
        <div className="props-seg">
          {KINDS.map(({ kind, icon: Icon, one, many: m }, i) => (
            <span key={kind} className="props-seg">
              {i === 3 ? <span className="props-seg-gap" /> : null}
              <button
                type="button"
                className="icon-btn"
                title={many ? m : `${one} to the canvas`}
                aria-label={many ? m : `${one} to the canvas`}
                disabled={off}
                onClick={() => alignSelection(ids, kind, to)}
              >
                <Icon size={14} />
              </button>
            </span>
          ))}
        </div>
      </Row>
      {many ? (
        <Row label="spread" title="equal gaps between the clips, the outer two stay where they are">
          <div className="props-seg">
            <button
              type="button"
              className="icon-btn"
              title="spread out evenly, left to right"
              aria-label="spread out evenly, left to right"
              disabled={usable < 3}
              onClick={() => spreadSelection(ids, 'x')}
            >
              <AlignHorizontalSpaceBetween size={14} />
            </button>
            <button
              type="button"
              className="icon-btn"
              title="spread out evenly, top to bottom"
              aria-label="spread out evenly, top to bottom"
              disabled={usable < 3}
              onClick={() => spreadSelection(ids, 'y')}
            >
              <AlignVerticalSpaceBetween size={14} />
            </button>
          </div>
        </Row>
      ) : null}
      {usable < visual || (many && usable < 2) ? (
        <div className="props-hint">3d clips, attached clips and clips on locked tracks are left out</div>
      ) : null}
    </>
  );
});
