import { memo } from 'react';
import { ClipboardPaste, Copy, RotateCcw } from 'lucide-react';
import type { BlendMode, VisualClip } from '../../types';
import { useUi } from '../../store/ui';
import { AnimField } from './AnimField';
import { resetWithKeys } from './animEdit';
import { SelectRow, Section } from './controls';
import { patchClip } from './edit';
import { BLEND_LABELS, MAX_CROP_EDGE } from './look';
import { copyLook, pasteLook, useLookClipboard } from './lookClipboard';

const EDGES = [
  { edge: 'left', label: 'crop left', title: 'cut off the left edge (%)' },
  { edge: 'top', label: 'crop top', title: 'cut off the top edge (%)' },
  { edge: 'right', label: 'crop right', title: 'cut off the right edge (%)' },
  { edge: 'bottom', label: 'crop bottom', title: 'cut off the bottom edge (%)' },
] as const;
const CROP_PROPS = EDGES.map((e) => 'crop.' + e.edge);

/** the crop has something to reset: an edge is cut, or an edge is animated */
function cropActive(clip: VisualClip): boolean {
  return !!clip.crop || CROP_PROPS.some((p) => !!clip.keyframes?.[p]?.length);
}

/** copy look / paste look buttons. `ids` = the clips the paste goes to. */
export function LookButtons({ source, ids }: { source: VisualClip; ids: string[] }) {
  const look = useLookClipboard();
  return (
    <div className="props-buttons">
      <button
        type="button"
        className="btn btn-sm"
        title="copy blend, crop, corners, opacity, motion, color, green screen, mask, transition and text style"
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
        <AnimField
          id={id}
          prop="radius"
          label="corners"
          title="round the corners (0 square, 100 fully round)"
          scale={100}
          suffix="%"
          min={0}
          max={100}
          step={1}
          precision={0}
        />
      ) : null}
      {!isText ? (
        <>
          {EDGES.map(({ edge, label, title }) => (
            <AnimField
              key={edge}
              id={id}
              prop={'crop.' + edge}
              label={label}
              title={title}
              scale={100}
              suffix="%"
              min={0}
              max={MAX_CROP_EDGE}
              step={1}
              precision={0}
            />
          ))}
          <div className="props-buttons">
            <button type="button" className="btn btn-sm" title="remove the crop" disabled={!cropActive(clip)} onClick={() => resetWithKeys(id, CROP_PROPS, { crop: null })}>
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
