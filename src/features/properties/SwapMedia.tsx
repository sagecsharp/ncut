import { memo, useMemo } from 'react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { MediaKind } from '../../types';
import { Row } from './controls';
import { swapOptions } from './mediaSwap';

/** "swap media": replace the file a video / image / audio clip plays, as one undo step. hidden when there is nothing to swap to. */
export const SwapMedia = memo(function SwapMedia({ id, assetId, kind }: { id: string; assetId: string; kind: MediaKind }) {
  const assets = useEditor((s) => s.project?.assets);
  const options = useMemo(() => (assets ? swapOptions(assets, assetId, kind) : []), [assets, assetId, kind]);
  if (options.length === 0) return null;
  return (
    <Row label="media" title="replace the file this clip uses. timing and look stay">
      <select
        className="select"
        title="swap media: use another file of the same kind"
        aria-label="swap media"
        value=""
        onChange={(e) => {
          const next = e.target.value;
          if (next === '') return;
          if (!useEditor.getState().replaceClipAsset(id, next)) useUi.getState().toast('cannot swap this media here', 'error');
        }}
      >
        <option value="">swap with...</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
    </Row>
  );
});
