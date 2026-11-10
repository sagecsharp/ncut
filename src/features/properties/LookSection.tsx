import { memo } from 'react';
import { ClipboardPaste, Copy, RotateCcw } from 'lucide-react';
import { NumberField } from '../../components/ui/NumberField';
import type { BlendMode, Crop, VisualClip } from '../../types';
import { useUi } from '../../store/ui';
import { Row, SelectRow, Section } from './controls';
import { beginEdit, patchClip } from './edit';
import { BLEND_LABELS, cropPercent, maxCropPercent, setCropEdge } from './look';
import type { CropEdge } from './look';
import { copyLook, pasteLook, useLookClipboard } from './lookClipboard';

const EDGES: { edge: CropEdge; label: string; title: string }[] = [
  { edge: 'left', label: 'l', title: 'cut off the left edge (%)' },
  { edge: 'top', label: 't', title: 'cut off the top edge (%)' },
  { edge: 'right', label: 'r', title: 'cut off the right edge (%)' },
  { edge: 'bottom', label: 'b', title: 'cut off the bottom edge (%)' },
];

/** copy look / paste look buttons. `ids` = the clips the paste goes to. */
export function LookButtons({ source, ids }: { source: VisualClip; ids: string[] }) {
  const look = useLookClipboard();
  return (
    <div className="props-buttons">
      <button
        type="button"
        className="btn btn-sm"
        title="copy blend, crop, corners, opacity, motion, transition and text style"
        onClick={() => {
          copyLook(source);
          useUi.getState().toast('look copied');
        }}
      >
        <Copy size={14} />
        copy look
      </button>
      <button
        type="button"
        className="btn btn-sm"
        title={look ? 'paste the copied look on the selected clips' : 'copy a look first'}
        disabled={!look}
        onClick={() => {
          const n = pasteLook(ids);
          useUi.getState().toast(n > 0 ? `look pasted on ${n} clip${n === 1 ? '' : 's'}` : 'select a video, image, text or shape clip first');
        }}
      >
        <ClipboardPaste size={14} />
        paste look
      </button>
    </div>
  );
}

export const LookSection = memo(function LookSection({ clip }: { clip: VisualClip }) {
  const id = clip.id;
  const isText = clip.type === 'text';
  const crop: Crop | null | undefined = clip.crop;

  return (
    <Section id="look" title="look">
      <SelectRow
        label="blend"
        title="how the picture mixes with what is under it"
        value={clip.blend ?? 'normal'}
        options={BLEND_LABELS}
        onChange={(v) => patchClip(id, { blend: (v as BlendMode) === 'normal' ? null : v })}
      />
      {!isText ? (
        <Row label="corners" title="round the corners (0 square, 100 fully round)">
          <NumberField
            className="props-grow"
            suffix="%"
            title="corner roundness (%)"
            value={Math.round((clip.radius ?? 0) * 100)}
            min={0}
            max={100}
            precision={0}
            onStart={beginEdit}
            onChange={(v) => patchClip(id, { radius: v <= 0 ? null : v / 100 }, true)}
          />
        </Row>
      ) : null}
      {!isText ? (
        <>
          <Row label="crop" title="cut the edges off (%): left, top, right, bottom">
            <div className="props-crop">
              {EDGES.map(({ edge, label, title }) => (
                <NumberField
                  key={edge}
                  label={label}
                  suffix="%"
                  title={title}
                  value={cropPercent(crop, edge)}
                  min={0}
                  max={maxCropPercent(crop, edge)}
                  precision={0}
                  onStart={beginEdit}
                  onChange={(v) => patchClip(id, { crop: setCropEdge(crop, edge, v) }, true)}
                />
              ))}
            </div>
          </Row>
          <div className="props-buttons">
            <button type="button" className="btn btn-sm" title="remove the crop" disabled={!crop} onClick={() => patchClip(id, { crop: null })}>
              <RotateCcw size={14} />
              reset crop
            </button>
          </div>
        </>
      ) : null}
      <LookButtons source={clip} ids={[id]} />
    </Section>
  );
});
