/** every way a media asset reaches the timeline goes through here: a video with sound can arrive as a pair (the setting) */
import { useEditor } from '../../store/editorStore';
import type { EditorState } from '../../store/editorStore';
import { separateSound } from './soundActions';
import { useSoundApart } from './soundSetting';

export type InsertMediaOpts = NonNullable<Parameters<EditorState['insertAsset']>[1]>;

export function insertMedia(assetId: string, opts?: InsertMediaOpts): string | null {
  const ed = useEditor.getState();
  const asset = ed.project?.assets.find((a) => a.id === assetId);
  const parts = opts?.parts;
  // 'picture' and 'sound' never separate: the caller chose a side
  const apart = !!asset && asset.kind === 'video' && asset.hasAudio && (parts === undefined || parts === 'both') && useSoundApart.getState().apart;
  if (!apart) return ed.insertAsset(assetId, opts);
  const inner = !!opts?.skipHistory;
  if (!inner) ed.pushHistory();
  const id = useEditor.getState().insertAsset(assetId, { ...opts, skipHistory: true });
  if (id === null) {
    if (!inner) useEditor.getState().rollback();
    return null;
  }
  // a picture that cannot be separated stays a plain clip
  separateSound([id], { skipHistory: true });
  return id;
}
