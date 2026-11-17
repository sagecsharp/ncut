import { useState } from 'react';
import type { ReactNode } from 'react';
import { SliderField } from '../../components/ui/SliderField';
import { dbtpText, luText, lufsText } from '../../lib/loudness';
import type { Project } from '../../types';
import { tip } from '../shell/tip';
import { TEXT } from './delivery';
import { DEFAULT_CEILING, LOUDNESS_TARGETS, LOUD_TEXT, pickTarget, planLine, wantsLoudness } from './loudnessTypes';
import { setLoudnessPref, useLoudnessPref } from './loudnessPrefs';
import { measureNow } from './measureMix';
import type { TimeRange } from './range';
import { useMeasureState } from './useMeasureState';

export interface LoudnessRowProps {
  project: Project;
  /** the part of the timeline the export covers, already clamped. null = none */
  range: TimeRange | null;
  /** false = the file has no sound (include audio is off): the row is greyed and sends nothing */
  live: boolean;
  /** the sample rate the mix is made at */
  rate: number;
}

const CUSTOM_REST = -23;

/** the loudness target and the peak limit of an export, and what the export will do with this mix */
export function LoudnessRow({ project, range, live, rate }: LoudnessRowProps) {
  const l = useLoudnessPref((s) => s.loudness);
  const [custom, setCustom] = useState(false);
  const wants = wantsLoudness(l);
  const measure = useMeasureState(live && wants ? project : null, live && wants ? range : null, rate);
  const off = live ? null : TEXT.audioOff;
  const preset = l.target !== null && LOUDNESS_TARGETS.some((t) => t.lufs === l.target);
  const showCustom = l.target !== null && (custom || !preset);
  const write = (next: typeof l): void => {
    if (live) setLoudnessPref(next);
  };

  let status: ReactNode = null;
  if (live && wants) {
    const r = measure.result;
    if (r && !measure.stale) {
      const n = r.numbers;
      const lines = r.silent ? ['no sound in this range'] : planLine(r, l).split('\n');
      status = (
        <div
          className="export-summary"
          {...tip('measured loudness', { does: `measured ${lufsText(n.integrated)}, range ${luText(n.lra)}, peak ${dbtpText(n.truePeak)}. ${LOUD_TEXT.beforeCodec}` })}
        >
          {lines.map((line, i) =>
            i === 0 ? (
              <div key={line}>{line}</div>
            ) : (
              <div key={line} className="export-note is-warn">
                {line}
              </div>
            ),
          )}
        </div>
      );
    } else {
      status = (
        <div className="export-summary export-loud-status">
          <span>measured when the export starts</span>
          {measure.progress !== null ? (
            <span className="mono">{`measuring ${Math.round(measure.progress * 100)}%`}</span>
          ) : (
            <button
              type="button"
              className="btn btn-sm"
              aria-disabled={range ? undefined : 'true'}
              {...tip('measure now', { does: 'renders the sound of the range now and gives the exact loudness, range and true peak', off: range ? null : 'there is nothing to measure in this range' })}
              onClick={() => {
                if (range) measureNow(project, range, rate);
              }}
            >
              measure now
            </button>
          )}
        </div>
      );
    }
  }

  return (
    <div className="field export-loud" data-delivery-row="loudness" aria-disabled={live ? undefined : 'true'}>
      <label className="field">
        <span className="field-label">loudness</span>
        <select
          className="select"
          aria-label="loudness target"
          aria-disabled={live ? undefined : 'true'}
          {...tip('loudness', { does: 'the export gains the mix to this loudness', off })}
          value={showCustom ? 'custom' : l.target === null ? 'off' : String(l.target)}
          onChange={(e) => {
            const v = e.target.value;
            if (!live) return;
            if (v === 'off') {
              setCustom(false);
              write(pickTarget(l, null));
            } else if (v === 'custom') {
              setCustom(true);
              write(pickTarget(l, l.target ?? CUSTOM_REST));
            } else {
              setCustom(false);
              write(pickTarget(l, Number(v)));
            }
          }}
        >
          <option value="off">off</option>
          {LOUDNESS_TARGETS.map((t) => (
            <option key={t.lufs} value={String(t.lufs)}>
              {t.label}
            </option>
          ))}
          <option value="custom">custom</option>
        </select>
      </label>
      {showCustom && (
        <SliderField
          value={l.target ?? CUSTOM_REST}
          min={-36}
          max={-6}
          step={0.1}
          precision={1}
          rest={CUSTOM_REST}
          suffix="lufs"
          disabled={!live}
          ariaLabel="loudness target in lufs"
          title="the loudness the export aims for"
          onStart={() => undefined}
          onChange={(v) => write({ ...l, target: v })}
        />
      )}
      <div className="field-row">
        <label className="field-row export-check" {...tip('peak limit', { does: 'a true peak limiter keeps the file under this level', off })}>
          <input
            type="checkbox"
            className="checkbox"
            aria-disabled={live ? undefined : 'true'}
            checked={l.ceiling !== null}
            onChange={(e) => write({ ...l, ceiling: e.target.checked ? DEFAULT_CEILING : null })}
          />
          <span>peak limit</span>
        </label>
        <SliderField
          value={l.ceiling ?? DEFAULT_CEILING}
          min={-9}
          max={0}
          step={0.1}
          precision={1}
          rest={DEFAULT_CEILING}
          suffix="dbtp"
          disabled={!live || l.ceiling === null}
          ariaLabel="peak limit in dbtp"
          title="the highest the true peak may reach"
          onStart={() => undefined}
          onChange={(v) => write({ ...l, ceiling: v })}
        />
      </div>
      {status}
    </div>
  );
}
