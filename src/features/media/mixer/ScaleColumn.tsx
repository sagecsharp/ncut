import { faderPos } from '../../../lib/meter';

const MARKS: readonly number[] = [12, 6, 0, -6, -12, -20, -30, -40, -60];

/** the db marks beside the faders. its rows are as tall as a strip's rows (css variables), the marks sit on the fader scale */
export function ScaleColumn() {
  return (
    <div className="mixer-scale" aria-hidden="true">
      <div className="mixer-name-row" />
      <div className="mixer-pan-row mixer-scale-pan">pan</div>
      <div className="mixer-fader-row">
        <div className="mixer-scale-marks">
          {MARKS.map((db) => (
            <span key={db} className="mixer-scale-mark" style={{ bottom: `${faderPos(db) * 100}%` }}>
              {db}
            </span>
          ))}
        </div>
      </div>
      <div className="mixer-level-row" />
      <div className="mixer-btn-row" />
    </div>
  );
}
