import { memo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import { useEditor } from '../../store/editorStore';
import type { SceneFog } from '../../types';
import { ColorField, Row, Section, SliderRow, Switch } from './controls';
import { beginEdit, liveOpts } from './edit';
import { FOG_GAP, FOG_MAX, defaultFog, setFogAmount, setFogFar, setFogNear } from './fogLogic';

const setFog = (fog: SceneFog | null, live = false) => useEditor.getState().updateProject({ fog }, live ? liveOpts() : undefined);

/** haze for the 3d space (Project.fog). shown in the project inspector. */
export const FogSection = memo(function FogSection({ fog, background }: { fog: SceneFog | null | undefined; background: string }) {
  return (
    <Section id="fog" title="fog">
      <Row label="fog" title="fade 3d clips into a color with distance" wide>
        <Switch checked={!!fog} title="fog on or off" onChange={(on) => setFog(on ? defaultFog(background, useEditor.getState().project?.height) : null)} />
      </Row>
      {fog ? (
        <>
          <Row label="color" title="color of the fog">
            <ColorField title="fog color" value={fog.color} onChange={(c) => setFog({ ...fog, color: c }, true)} />
          </Row>
          <Row label="starts at" title="distance from the camera where the fog starts (px)" wide>
            <NumberField
              className="props-grow"
              suffix="px"
              title="fog starts at (px)"
              value={fog.near}
              min={0}
              max={FOG_MAX - FOG_GAP}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => setFog(setFogNear(fog, v), true)}
            />
          </Row>
          <Row label="full at" title="distance from the camera where the fog is at full strength (px)" wide>
            <NumberField
              className="props-grow"
              suffix="px"
              title="fog is full at (px)"
              value={fog.far}
              min={fog.near + FOG_GAP}
              max={FOG_MAX}
              precision={0}
              onStart={beginEdit}
              onChange={(v) => setFog(setFogFar(fog, v), true)}
            />
          </Row>
          <SliderRow
            label="strength"
            title="the most the fog covers (%)"
            value={Math.round(fog.amount * 100)}
            min={0}
            max={100}
            suffix="%"
            onChange={(v) => setFog(setFogAmount(fog, v), true)}
          />
        </>
      ) : null}
      <div className="props-hint">fades 3d clips into this color with distance. 2d clips are not affected</div>
    </Section>
  );
});
