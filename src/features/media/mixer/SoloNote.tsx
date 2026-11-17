import { useEditor } from '../../../store/editorStore';
import { useSolo } from '../../../store/solo';
import { soloActive } from '../../../lib/mix';

/** the export dialog's note when some track is on solo: the export has every track */
export function SoloNote({ sound }: { sound: boolean }) {
  const solo = useSolo((s) => s.solo);
  const on = useEditor((s) => soloActive(s.project, solo));
  if (!sound || !on) return null;
  return <div className="export-note">solo is on: the export has every track. solo is only for listening</div>;
}
