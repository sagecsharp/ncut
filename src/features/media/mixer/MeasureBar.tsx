import { useEditor } from '../../../store/editorStore';
import { inOutSpan } from '../../../lib/inOut';
import { projectDuration } from '../../../lib/timelineOps';
import { cancelMeasureNow, measureNow, mixerRange } from '../../export/measureMix';
import { measureRate, setLoudnessPref, useLoudnessPref } from '../../export/loudnessPrefs';
import { pickTarget } from '../../export/loudnessTypes';
import { useMeasureState } from '../../export/useMeasureState';
import { reasonFor, reasonSnapshot } from '../../shell/reasons';
import { tip } from '../../shell/tip';
import { measureLines, measureTip, measuringText, targetFromValue, targetOptions, targetValue } from './loudnessView';

/** the mixer toolbar's loudness part: measure mix, its progress, the loudness target and the result lines (they wrap under the toolbar) */
export function MeasureBar() {
  const project = useEditor((s) => s.project);
  const { loudness } = useLoudnessPref();
  const range = project ? mixerRange(project) : null;
  const { result, progress, stale } = useMeasureState(project, range, measureRate());
  const why = reasonFor('measure-loudness', reasonSnapshot());
  const whole = project ? inOutSpan(project.range, projectDuration(project)) === null : true;

  return (
    <>
      {progress !== null ? (
        <>
          <span className="mixer-measure-bar" aria-hidden="true">
            <span style={{ width: `${Math.round(progress * 100)}%` }} />
          </span>
          <span className="mixer-dim">{measuringText(progress)}</span>
          <button
            type="button"
            className="btn btn-sm"
            {...tip('cancel', { does: 'stop measuring' })}
            onClick={() => cancelMeasureNow()}
          >
            cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          className="btn btn-sm"
          disabled={!!why || !range}
          {...tip('measure mix', { does: 'renders the sound of in to out (or the whole timeline) and gives the exact loudness, range and true peak', why: 'measure-loudness' })}
          onClick={() => {
            if (project && range) measureNow(project, range, measureRate());
          }}
        >
          measure mix
        </button>
      )}
      <span className="mixer-dim">target</span>
      <select
        className="select"
        aria-label="loudness target"
        value={targetValue(loudness)}
        {...tip('loudness target', { does: 'the loudness the export aims for, the same choice as in the export dialog' })}
        onChange={(e) => setLoudnessPref(pickTarget(loudness, targetFromValue(e.target.value)))}
      >
        {targetOptions(loudness).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {result && progress === null ? (
        <div className={'mixer-measure' + (stale ? ' is-stale' : '')} data-measure-line {...tip('measured', { does: measureTip(result) })}>
          {measureLines(result, loudness, whole, stale).map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      ) : null}
    </>
  );
}
