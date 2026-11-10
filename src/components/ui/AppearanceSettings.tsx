import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../lib/appearance';
import { TINT_PRESETS, useAppearance } from '../../lib/appearance';

const MODES: { id: ThemeMode; label: string; title: string; Icon: typeof Monitor }[] = [
  { id: 'auto', label: 'auto', title: 'follow the system: black at night, white by day', Icon: Monitor },
  { id: 'dark', label: 'black', title: 'always the black theme', Icon: Moon },
  { id: 'light', label: 'white', title: 'always the white theme', Icon: Sun },
];

/** theme (auto / black / white) and tint controls. changes apply and save immediately. */
export function AppearanceSettings() {
  const mode = useAppearance((s) => s.mode);
  const hue = useAppearance((s) => s.tintHue);
  const strength = useAppearance((s) => s.tintStrength);
  const set = useAppearance((s) => s.setAppearance);

  return (
    <div className="appearance">
      <div className="field">
        <span className="field-label">theme</span>
        <div className="appearance-modes" role="radiogroup" aria-label="theme">
          {MODES.map(({ id, label, title, Icon }) => (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={mode === id}
              className={`btn appearance-mode${mode === id ? ' is-active' : ''}`}
              title={title}
              onClick={() => set({ mode: id })}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="field">
        <span className="field-label">tint</span>
        <div className="appearance-swatches">
          {TINT_PRESETS.map((p) => {
            const active = p.strength === 0 ? strength === 0 : strength > 0 && Math.abs(hue - p.hue) < 1;
            return (
              <button
                key={p.id}
                type="button"
                className={`appearance-swatch${active ? ' is-active' : ''}`}
                title={p.strength === 0 ? 'no tint: pure black and white' : `${p.label} tint`}
                aria-label={`${p.label} tint`}
                aria-pressed={active}
                style={{ background: p.strength === 0 ? 'var(--text-dim)' : `oklch(0.75 0.13 ${p.hue})` }}
                onClick={() => set({ tintHue: p.hue, tintStrength: p.strength === 0 ? 0 : Math.max(strength, p.strength) })}
              />
            );
          })}
        </div>
      </div>

      <div className="field-row">
        <span className="field-label appearance-label">hue</span>
        <input
          className="range"
          type="range"
          min={0}
          max={360}
          step={1}
          value={hue}
          title="tint hue"
          aria-label="tint hue"
          onChange={(e) => set({ tintHue: Number(e.target.value), tintStrength: strength === 0 ? 40 : strength })}
        />
        <span className="mono appearance-value">{Math.round(hue)}°</span>
      </div>
      <div className="field-row">
        <span className="field-label appearance-label">strength</span>
        <input
          className="range"
          type="range"
          min={0}
          max={100}
          step={1}
          value={strength}
          title="tint strength. 0 is pure black and white."
          aria-label="tint strength"
          onChange={(e) => set({ tintStrength: Number(e.target.value) })}
        />
        <span className="mono appearance-value">{Math.round(strength)}%</span>
      </div>
    </div>
  );
}
