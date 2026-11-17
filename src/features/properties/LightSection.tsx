import { memo, useMemo } from 'react';
import { roundShown } from '../../components/ui/numberFormat';
import { skyLightOf } from '../../engine/scene3d/light';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { SceneLight } from '../../types';
import { ColorField, Row, Section, SliderRow, Switch } from './controls';
import { liveOpts } from './edit';
import { autoKey, defaultLight, setSunHeight, setSunPercent, setSunTurn } from './lightLogic';

const setLight = (light: SceneLight | null, live = false) => useEditor.getState().updateProject({ light }, live ? liveOpts() : undefined);

/** the three colors the scene gives lit 3d clips when there is no own light, live at the playhead */
function AutoChips() {
  const project = useEditor((s) => s.project);
  // while playing: quarter seconds, so the colors are not worked out on every frame. paused: the exact playhead
  const t = usePlayback((s) => (s.playing ? Math.floor(s.time * 4) / 4 : s.time));
  const key = useMemo(() => (project ? autoKey(project, t) : ''), [project, t]);
  const fromSky = useEditor((s) => !!s.project && !!s.project.sky && skyLightOf(s.project) !== null);
  const [sky, horizon, ground] = key.split(' ');
  const chip = (name: string, hex: string | undefined) =>
    hex ? (
      <span
        key={name}
        title={`${name} ${hex}`}
        style={{ display: 'inline-block', width: 14, height: 14, borderRadius: 3, border: '1px solid var(--border-soft)', background: hex }}
      />
    ) : null;
  return (
    <Row label={fromSky ? 'from the sky' : 'from the scene'} title={fromSky ? 'the light the sky gives: sky, horizon, ground' : 'the light the scene gives right now: sky, horizon, ground'} wide>
      <span style={{ display: 'inline-flex', gap: 6 }}>
        {chip('sky', sky)}
        {chip('horizon', horizon)}
        {chip('ground', ground)}
      </span>
    </Row>
  );
}

/** the light of lit 3d clips (Project.light). shown in the project inspector. */
export const LightSection = memo(function LightSection({ light }: { light: SceneLight | null | undefined }) {
  return (
    <Section id="light" title="light">
      <Row label="own light" title="set the light of lit 3d clips here instead of taking it from the scene" wide>
        <Switch
          checked={!!light}
          title="own light on or off"
          onChange={(on) => {
            const project = useEditor.getState().project;
            setLight(on && project ? defaultLight(project, usePlayback.getState().time) : null);
          }}
        />
      </Row>
      {light ? (
        <>
          <Row label="sky" title="light from above">
            <ColorField title="sky color" value={light.sky} onChange={(c) => setLight({ ...light, sky: c }, true)} />
          </Row>
          <Row label="horizon" title="light from the sides, what a clip facing the camera gets">
            <ColorField title="horizon color" value={light.horizon} onChange={(c) => setLight({ ...light, horizon: c }, true)} />
          </Row>
          <Row label="ground" title="light from below">
            <ColorField title="ground color" value={light.ground} onChange={(c) => setLight({ ...light, ground: c }, true)} />
          </Row>
          <SliderRow
            label="sun"
            title="share of the sun in the light (%)"
            value={roundShown(light.sun * 100, 0)}
            feel="sun"
            onChange={(v) => setLight(setSunPercent(light, v), true)}
          />
          <Row label="sun color" title="color of the sun">
            <ColorField title="sun color" value={light.sunColor} onChange={(c) => setLight({ ...light, sunColor: c }, true)} />
          </Row>
          <SliderRow
            label="sun turn"
            title="where the sun stands around the scene (deg). 0 = behind the camera"
            value={light.sunTurn}
            feel="sunTurn"
            onChange={(v) => setLight(setSunTurn(light, v), true)}
          />
          <SliderRow
            label="sun height"
            title="how high the sun stands (deg). 90 = straight above"
            value={light.sunHeight}
            feel="sunHeight"
            onChange={(v) => setLight(setSunHeight(light, v), true)}
          />
        </>
      ) : (
        <AutoChips />
      )}
      <div className="props-hint">
        lights the 3d clips that have lit on. light only darkens or tints: white light leaves a clip as it is, a dark scene makes it darker (lower how lit to soften it). without an own light it comes from the sky when the project has one, else from the background, the filled 2d shapes under the lowest 3d clip and the fog (pictures, video and text are not read). 2d clips are not affected
      </div>
    </Section>
  );
});
