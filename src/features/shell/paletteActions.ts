import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { closeProject, exportProjectFile } from '../../store/session';
import { useUi } from '../../store/ui';
import { SHORTCUTS } from './shortcuts';

export interface PaletteAction {
  id: string;
  title: string;
  group: string;
  /** key caps, same shape as Shortcut.keys */
  keys: readonly (readonly string[])[];
  run(): void;
}

async function saveProjectFile(): Promise<void> {
  const project = useEditor.getState().project;
  if (!project) return;
  const file = await exportProjectFile(project.id);
  if (!file) {
    useUi.getState().toast('could not save the project file', 'error');
    return;
  }
  const url = URL.createObjectURL(file.blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

/** actions without a key: reachable through the stores like the header buttons do */
const EXTRA: readonly PaletteAction[] = [
  { id: 'back-to-projects', title: 'back to projects', group: 'app', keys: [], run: () => void closeProject() },
  { id: 'save-file', title: 'save project file', group: 'app', keys: [], run: () => void saveProjectFile() },
  {
    id: 'toggle-loop',
    title: 'toggle loop',
    group: 'playback',
    keys: [],
    run: () => {
      const pb = usePlayback.getState();
      pb.setLoop(!pb.loop);
      useUi.getState().toast(pb.loop ? 'loop off' : 'loop on');
    },
  },
  { id: 'speed-half', title: 'preview speed 0.5x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(0.5) },
  { id: 'speed-one', title: 'preview speed 1x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(1) },
  { id: 'speed-double', title: 'preview speed 2x', group: 'playback', keys: [], run: () => usePlayback.getState().setSpeed(2) },
];

/** every runnable shortcut row (same run() as the keyboard) followed by the extras */
export function paletteActions(): PaletteAction[] {
  const rows: PaletteAction[] = SHORTCUTS.filter((s) => !s.info && s.id !== 'palette').map((s) => ({
    id: s.id,
    title: s.description,
    group: s.group,
    keys: s.keys,
    run: s.run,
  }));
  return [...rows, ...EXTRA];
}
