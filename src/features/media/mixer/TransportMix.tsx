import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { useEditor } from '../../../store/editorStore';
import { useSolo } from '../../../store/solo';
import { useUi } from '../../../store/ui';
import { soloActive } from '../../../lib/mix';
import { OUTPUT_TAP } from '../../preview/meterTaps';
import { pressesCard } from '../../../lib/pressKey';
import { tip } from '../../shell/tip';
import { Meter } from './Meter';
import './mixer.css';

/** the transport gets too narrow for the meter below this width (px) */
const METER_MIN_W = 560;

/** the transport's part of the mixer: a pill while solo is on, the output meter (it hides when the transport is narrow) */
export function TransportMix() {
  const root = useRef<HTMLDivElement>(null);
  const [wide, setWide] = useState(false);
  const solo = useSolo((s) => s.solo);
  const active = useEditor((s) => soloActive(s.project, solo));

  // no container query: the transport's css is not ours, so its width is watched here
  useEffect(() => {
    const host = root.current?.closest('.preview-transport');
    if (!host) {
      setWide(true);
      return;
    }
    const measure = () => setWide(host.clientWidth >= METER_MIN_W);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(host);
    return () => ro.disconnect();
  }, []);

  const open = () => useUi.getState().showMixer();
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!pressesCard(e)) return;
    e.preventDefault();
    open();
  };

  return (
    <div className="transport-mix" ref={root}>
      {active ? (
        <button
          type="button"
          className="transport-solo"
          {...tip('solo on', { does: 'you hear only some tracks. click to hear every track. the export always has every track' })}
          onClick={() => useSolo.getState().clearSolo()}
        >
          solo on
        </button>
      ) : null}
      {wide ? (
        <div
          className="transport-meter"
          role="button"
          tabIndex={0}
          aria-label="output meter"
          {...tip('output meter', { does: 'how loud the whole mix is. click to open the mixer', keys: 'open-mixer' })}
          onClick={open}
          onKeyDown={onKey}
        >
          <Meter tap={OUTPUT_TAP} horizontal />
        </div>
      ) : null}
    </div>
  );
}
