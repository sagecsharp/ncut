import { memo, useMemo } from 'react';
import { NumberField } from '../../components/ui/NumberField';
import { CANVAS_PRESETS, FPS_OPTIONS } from '../../lib/factory';
import { formatTimecode } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import type { Project } from '../../types';
import { ColorField, Pair, Row, Section } from './controls';
import { beginEdit, even, liveOpts } from './edit';

const ProjectSettings = memo(function ProjectSettings({
  name,
  width,
  height,
  fps,
  background,
}: Pick<Project, 'name' | 'width' | 'height' | 'fps' | 'background'>) {
  const presetId = CANVAS_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? 'custom';
  const fpsOptions = FPS_OPTIONS.includes(fps) ? FPS_OPTIONS : [...FPS_OPTIONS, fps].sort((a, b) => a - b);
  const update = useEditor.getState().updateProject;
  return (
    <Section id="project" title="project">
      <Row label="name" title="project name">
        <input
          className="input"
          title="project name"
          value={name}
          onFocus={beginEdit}
          onChange={(e) => update({ name: e.target.value }, liveOpts())}
        />
      </Row>
      <Row label="canvas" title="canvas size preset">
        <select
          className="select"
          title="canvas size preset"
          value={presetId}
          onChange={(e) => {
            const p = CANVAS_PRESETS.find((x) => x.id === e.target.value);
            if (p) update({ width: p.width, height: p.height });
          }}
        >
          {presetId === 'custom' ? <option value="custom">custom</option> : null}
          {CANVAS_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </Row>
      <Row label="size" title="canvas width and height in pixels">
        <Pair>
          <NumberField
            label="w"
            suffix="px"
            title="canvas width"
            value={width}
            min={16}
            max={8192}
            onStart={beginEdit}
            onChange={(v) => update({ width: even(v) }, liveOpts())}
          />
          <NumberField
            label="h"
            suffix="px"
            title="canvas height"
            value={height}
            min={16}
            max={8192}
            onStart={beginEdit}
            onChange={(v) => update({ height: even(v) }, liveOpts())}
          />
        </Pair>
      </Row>
      <Row label="fps" title="frame rate">
        <select
          className="select"
          title="frame rate"
          value={fps}
          onChange={(e) => update({ fps: Number(e.target.value) })}
        >
          {fpsOptions.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </Row>
      <Row label="background" title="canvas background color">
        <ColorField title="background color" value={background} onChange={(c) => update({ background: c }, liveOpts())} />
      </Row>
    </Section>
  );
});

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="props-stat">
      <span className="field-label">{label}</span>
      <span className="mono">{value}</span>
    </div>
  );
}

const ProjectStats = memo(function ProjectStats({
  clips,
  trackCount,
  assetCount,
  fps,
}: {
  clips: Project['clips'];
  trackCount: number;
  assetCount: number;
  fps: number;
}) {
  const duration = useMemo(() => projectDuration({ clips }), [clips]);
  return (
    <Section id="stats" title="stats">
      <Stat label="duration" value={formatTimecode(duration, fps)} />
      <Stat label="tracks" value={trackCount} />
      <Stat label="clips" value={clips.length} />
      <Stat label="assets" value={assetCount} />
    </Section>
  );
});

export function ProjectInspector() {
  const project = useEditor((s) => s.project);
  if (!project) return null;
  return (
    <section className="panel props-panel">
      <div className="panel-header">
        <span className="panel-title" title={project.name}>
          {project.name || 'project'}
        </span>
        <span className="props-tag">project</span>
      </div>
      <div className="panel-body">
        <ProjectSettings
          name={project.name}
          width={project.width}
          height={project.height}
          fps={project.fps}
          background={project.background}
        />
        <ProjectStats
          clips={project.clips}
          trackCount={project.tracks.length}
          assetCount={project.assets.length}
          fps={project.fps}
        />
      </div>
    </section>
  );
}
