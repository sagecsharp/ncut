import { RotateCcw } from 'lucide-react';
import { AppearanceSettings } from '../../components/ui/AppearanceSettings';
import { McpSettings } from '../../components/ui/McpSettings';
import { UpdateSettings } from '../../components/ui/UpdateSettings';
import { useUi } from '../../store/ui';
import { resetLayout } from '../editor/layoutReset';
import { useSceneControls } from '../preview/sceneControls';
import { useSoundApart } from '../timeline/soundSetting';
import { Switch } from '../../components/ui/Switch';
import './shell.css';

/** the settings of the app itself (not of a project). shown in the editor dialog and on the projects screen. */
export function AppSettings() {
  const sceneScheme = useSceneControls((s) => s.scheme);
  const setSceneScheme = useSceneControls((s) => s.setScheme);
  const apart = useSoundApart((s) => s.apart);
  const setApart = useSoundApart((s) => s.setApart);

  return (
    <>
      <h3 className="shell-settings-heading">appearance</h3>
      <AppearanceSettings />
      <div className="field">
        <span className="field-label">panel layout</span>
        <button
          className="btn"
          title="put the panels back to their default sizes"
          onClick={() => {
            resetLayout();
            useUi.getState().toast('layout reset');
          }}
        >
          <RotateCcw size={14} />
          reset layout
        </button>
      </div>
      <div className="field">
        <span className="field-label">unity 3d controls</span>
        <Switch
          checked={sceneScheme === 'unity'}
          title="drive the 3d scene view like unity: left drag orbits, w e r pick the tool. off: like blender (middle drag orbits, g r s move, rotate and scale)"
          onChange={(on) => setSceneScheme(on ? 'unity' : 'blender')}
        />
      </div>
      <div className="field">
        <span className="field-label">separate sound on drop</span>
        <Switch
          checked={apart}
          title="a video with sound you put on the timeline arrives as two grouped clips: the picture on a video track, the sound on an audio track. off: one clip with its sound"
          onChange={setApart}
        />
      </div>

      <McpSettings />
      <UpdateSettings />
    </>
  );
}
