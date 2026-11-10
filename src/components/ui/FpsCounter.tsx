import { useEffect, useRef, useState } from 'react';
import { subscribePerf } from '../../lib/perf';

const STORAGE_KEY = 'ncut.fps';

function loadVisible(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== 'off';
  } catch {
    return true;
  }
}

/**
 * small editor performance readout pinned to a corner: fps + worst frame time.
 * writes straight to the dom (no react re-render per sample). click to hide, click the dot to show.
 */
export function FpsCounter() {
  const [visible, setVisible] = useState(loadVisible);
  const fpsRef = useRef<HTMLSpanElement>(null);
  const msRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, visible ? 'on' : 'off');
    } catch {
      // ignore
    }
    if (!visible) return;
    return subscribePerf((s) => {
      if (fpsRef.current) fpsRef.current.textContent = String(Math.round(s.fps));
      if (msRef.current) msRef.current.textContent = `${s.worstMs.toFixed(1)} ms`;
      const level = s.fps >= 50 ? 'good' : s.fps >= 30 ? 'ok' : 'bad';
      if (rootRef.current) rootRef.current.dataset.level = level;
    });
  }, [visible]);

  if (!visible) {
    return (
      <button className="fps-counter is-collapsed" onClick={() => setVisible(true)} title="show editor fps" aria-label="show editor fps" />
    );
  }
  return (
    <button
      ref={rootRef}
      className="fps-counter mono"
      data-level="good"
      onClick={() => setVisible(false)}
      title="editor performance: frames per second and the slowest frame in the last half second. click to hide."
    >
      <span className="fps-counter-dot" />
      <span ref={fpsRef}>--</span>
      <span className="fps-counter-unit">fps</span>
      <span className="fps-counter-ms" ref={msRef}>
        -- ms
      </span>
    </button>
  );
}
