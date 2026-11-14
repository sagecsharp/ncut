import { useRef } from 'react';
import { Monitor, Moon, Sun } from 'lucide-react';
import type { ThemeMode } from '../../lib/appearance';
import { TINT_PRESETS, useAppearance } from '../../lib/appearance';
import type { WallpaperFit } from '../../lib/wallpaper';
import { WALLPAPER_ACCEPT, WALLPAPER_FITS, WALLPAPER_LIMITS, useWallpaper } from '../../lib/wallpaper';

const MODES: { id: ThemeMode; label: string; title: string; Icon: typeof Monitor }[] = [
  { id: 'auto', label: 'auto', title: 'follow the system: black at night, white by day', Icon: Monitor },
  { id: 'dark', label: 'black', title: 'always the black theme', Icon: Moon },
  { id: 'light', label: 'white', title: 'always the white theme', Icon: Sun },
];

/** theme (auto / black / white), tint and wallpaper controls. changes apply and save immediately. */
export function AppearanceSettings() {
  const mode = useAppearance((s) => s.mode);
  const hue = useAppearance((s) => s.tintHue);
  const strength = useAppearance((s) => s.tintStrength);
  const set = useAppearance((s) => s.setAppearance);

  const hasPicture = useWallpaper((s) => s.url !== null);
  const busy = useWallpaper((s) => s.busy);
  const fit = useWallpaper((s) => s.fit);
  const dim = useWallpaper((s) => s.dim);
  const blur = useWallpaper((s) => s.blur);
  const panels = useWallpaper((s) => s.panels);
  const setWallpaper = useWallpaper((s) => s.setSettings);
  const choosePicture = useWallpaper((s) => s.choosePicture);
  const removePicture = useWallpaper((s) => s.removePicture);
  const fileRef = useRef<HTMLInputElement>(null);

  const onPicked = (files: FileList | null) => {
    const file = files?.[0];
    // reset, so picking the same file again still fires a change
    if (fileRef.current) fileRef.current.value = '';
    if (file) void choosePicture(file);
  };

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

      <div className="field">
        <span className="field-label">wallpaper</span>
        <div className="appearance-wallpaper">
          <button
            type="button"
            className="btn"
            disabled={busy}
            title="pick a picture to show behind the whole app (png, jpg, webp, avif, gif or bmp, up to 64 mb)"
            aria-label="choose a wallpaper picture"
            onClick={() => fileRef.current?.click()}
          >
            {busy ? 'reading...' : 'choose picture'}
          </button>
          <input ref={fileRef} type="file" hidden accept={WALLPAPER_ACCEPT} onChange={(e) => onPicked(e.target.files)} />
          {hasPicture ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              title="take the wallpaper away"
              aria-label="remove the wallpaper"
              onClick={() => void removePicture()}
            >
              remove
            </button>
          ) : null}
        </div>
      </div>

      {hasPicture ? (
        <>
          <div className="field-row">
            <span className="field-label appearance-label">fit</span>
            <select
              className="select appearance-select"
              value={fit}
              title="how the picture fills the window"
              aria-label="wallpaper fit"
              onChange={(e) => setWallpaper({ fit: e.target.value as WallpaperFit })}
            >
              {WALLPAPER_FITS.map((f) => (
                <option key={f.id} value={f.id} title={f.title}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          <div className="field-row">
            <span className="field-label appearance-label">dim</span>
            <input
              className="range"
              type="range"
              min={WALLPAPER_LIMITS.dim.min}
              max={WALLPAPER_LIMITS.dim.max}
              step={1}
              value={dim}
              title="how much of the theme's background color lies over the picture"
              aria-label="wallpaper dim"
              onChange={(e) => setWallpaper({ dim: Number(e.target.value) })}
            />
            <span className="mono appearance-value">{Math.round(dim)}%</span>
          </div>
          <div className="field-row">
            <span className="field-label appearance-label">blur</span>
            <input
              className="range"
              type="range"
              min={WALLPAPER_LIMITS.blur.min}
              max={WALLPAPER_LIMITS.blur.max}
              step={1}
              value={blur}
              title="blur the picture"
              aria-label="wallpaper blur"
              onChange={(e) => setWallpaper({ blur: Number(e.target.value) })}
            />
            <span className="mono appearance-value">{Math.round(blur)}px</span>
          </div>
          <div className="field-row">
            <span className="field-label appearance-label">panels</span>
            <input
              className="range"
              type="range"
              min={WALLPAPER_LIMITS.panels.min}
              max={WALLPAPER_LIMITS.panels.max}
              step={1}
              value={panels}
              title="how solid the panels are. 100 is solid: the picture only shows where nothing covers it."
              aria-label="panels solidity"
              onChange={(e) => setWallpaper({ panels: Number(e.target.value) })}
            />
            <span className="mono appearance-value">{Math.round(panels)}%</span>
          </div>
        </>
      ) : null}
    </div>
  );
}
