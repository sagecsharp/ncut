import { memo, useMemo, useState } from 'react';
import { Columns2, Grid2x2, LayoutPanelLeft, LayoutPanelTop, PictureInPicture2, Rows2 } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { alignableClips } from './alignActions';
import { Row, SliderRow } from './controls';
import { splitScreen } from './splitActions';
import type { SplitKind } from './splitLayout';

const KINDS: { kind: SplitKind; icon: typeof Columns2; title: string }[] = [
  { kind: 'columns', icon: Columns2, title: 'side by side: one column per clip' },
  { kind: 'rows', icon: Rows2, title: 'stacked: one row per clip' },
  { kind: 'grid', icon: Grid2x2, title: 'grid: as square as possible' },
  { kind: 'bigLeft', icon: LayoutPanelLeft, title: 'the top layer big on the left, the others stacked on the right' },
  { kind: 'bigTop', icon: LayoutPanelTop, title: 'the top layer big on top, the others side by side below' },
  { kind: 'pip', icon: PictureInPicture2, title: 'picture in picture: the bottom layer fills the frame, the others are small windows' },
];

/**
 * split screen buttons for a selection of flat clips: pictures fill their cell and are cropped to it,
 * text and shapes are fitted inside. one click, one undo step.
 */
export const SplitButtons = memo(function SplitButtons({ ids }: { ids: string[] }) {
  const clips = useEditor((s) => s.project?.clips);
  const tracks = useEditor((s) => s.project?.tracks);
  const [gap, setGap] = useState(0);
  const usable = useMemo(() => (clips && tracks ? alignableClips({ clips, tracks }, ids).length : 0), [clips, tracks, ids]);
  const off = usable < 2;

  return (
    <>
      <Row label="split" title="split screen: every selected clip gets a part of the frame. pictures are cropped to fit.">
        <div className="props-seg">
          {KINDS.map(({ kind, icon: Icon, title }) => (
            <button key={kind} type="button" className="icon-btn" title={title} aria-label={title} disabled={off} onClick={() => splitScreen(ids, kind, gap)}>
              <Icon size={14} />
            </button>
          ))}
        </div>
      </Row>
      <SliderRow label="gap" title="space between the parts of the split screen (px). click a layout again to apply it." value={gap} min={0} max={80} suffix="px" disabled={off} onChange={setGap} />
    </>
  );
});
