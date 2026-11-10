import { ArrowLeftRight, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppearanceSettings } from '../../components/ui/AppearanceSettings';
import { Dialog } from '../../components/ui/Dialog';
import { NumberField } from '../../components/ui/NumberField';
import { CANVAS_PRESETS, FPS_OPTIONS } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { resetLayout } from '../editor/layoutReset';
import type { ProjectSettingsPatch } from '../../store/editorStore';
import './shell.css';

export interface ProjectSettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

const HEX_RE = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;
const MIN_SIDE = 16;
const MAX_SIDE = 7680;

/** turn any css color into #rrggbb (the color input only accepts that). */
function toHex(value: string, fallback = '#000000'): string {
  const m = HEX_RE.exec(value.trim());
  if (m) {
    const h = m[1]!;
    const full = h.length === 3 ? h.replace(/./g, (c) => c + c) : h;
    return `#${full.toLowerCase()}`;
  }
  try {
    const ctx = document.createElement('canvas').getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillStyle = value;
      const out = String(ctx.fillStyle);
      if (out.startsWith('#')) return out;
    }
  } catch {
    // fall through
  }
  return fallback;
}

export function ProjectSettingsDialog({ open, onClose }: ProjectSettingsDialogProps) {
  // the form only exists while open, so every opening starts from the current project
  if (!open) return null;
  return <SettingsForm onClose={onClose} />;
}

function SettingsForm({ onClose }: { onClose: () => void }) {
  const [initial] = useState(() => useEditor.getState().project);
  const [width, setWidth] = useState(initial?.width ?? 1920);
  const [height, setHeight] = useState(initial?.height ?? 1080);
  const [fps, setFps] = useState(initial?.fps ?? 30);
  const [hex, setHex] = useState(() => toHex(initial?.background ?? '#000000'));

  const presetId = useMemo(
    () => CANVAS_PRESETS.find((p) => p.width === width && p.height === height)?.id ?? 'custom',
    [width, height],
  );
  const fpsOptions = useMemo(
    () => (FPS_OPTIONS.includes(fps) ? FPS_OPTIONS : [...FPS_OPTIONS, fps].sort((a, b) => a - b)),
    [fps],
  );
  const hexValid = HEX_RE.test(hex.trim());
  const swatch = hexValid ? toHex(hex) : toHex(initial?.background ?? '#000000');

  if (!initial) return null;

  const apply = () => {
    if (!hexValid) return;
    const patch: ProjectSettingsPatch = {};
    if (width !== initial.width) patch.width = width;
    if (height !== initial.height) patch.height = height;
    if (fps !== initial.fps) patch.fps = fps;
    const bg = toHex(hex);
    if (bg !== toHex(initial.background)) patch.background = bg;
    // one call = one undo step
    if (Object.keys(patch).length > 0) useEditor.getState().updateProject(patch);
    onClose();
  };

  return (
    <Dialog
      open
      title="settings"
      onClose={onClose}
      width={420}
      footer={
        <>
          <button className="btn" onClick={onClose} title="discard changes">
            cancel
          </button>
          <button className="btn btn-primary" onClick={apply} disabled={!hexValid} title="apply these settings">
            apply
          </button>
        </>
      }
    >
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

      <h3 className="shell-settings-heading shell-settings-heading-sep">project</h3>
      <label className="field">
        <span className="field-label">canvas preset</span>
        <select
          className="select"
          value={presetId}
          title="canvas size preset"
          onChange={(e) => {
            const preset = CANVAS_PRESETS.find((p) => p.id === e.target.value);
            if (!preset) return;
            setWidth(preset.width);
            setHeight(preset.height);
          }}
        >
          {CANVAS_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">custom</option>
        </select>
      </label>

      <div className="field">
        <span className="field-label">canvas size</span>
        <div className="shell-settings-size">
          <NumberField label="w" suffix="px" value={width} min={MIN_SIDE} max={MAX_SIDE} onChange={setWidth} title="canvas width" />
 <button
            className="icon-btn"
            title="swap width and height"
            aria-label="swap width and height"
            onClick={() => {
              setWidth(height);
              setHeight(width);
            }}
          >
            <ArrowLeftRight size={14} />
          </button>
          <NumberField label="h" suffix="px" value={height} min={MIN_SIDE} max={MAX_SIDE} onChange={setHeight} title="canvas height" />
        </div>
      </div>

      <label className="field">
        <span className="field-label">frame rate</span>
        <select className="select" value={fps} title="project frame rate" onChange={(e) => setFps(Number(e.target.value))}>
          {fpsOptions.map((f) => (
            <option key={f} value={f}>
              {f} fps
            </option>
          ))}
        </select>
      </label>

      <div className="field">
        <span className="field-label">background color</span>
        <div className="field-row">
          <input
            className="input"
            type="color"
            value={swatch}
            title="pick background color"
            onChange={(e) => setHex(e.target.value)}
          />
          <input
            className={`input mono shell-settings-hex${hexValid ? '' : ' is-invalid'}`}
            type="text"
            value={hex}
            maxLength={7}
            spellCheck={false}
            title="background color as hex"
            onChange={(e) => setHex(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply();
            }}
          />
        </div>
      </div>
    </Dialog>
  );
}
