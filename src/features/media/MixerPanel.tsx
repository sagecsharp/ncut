import { useEffect, useMemo, useRef } from 'react';
import { RotateCcw } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { useSolo } from '../../store/solo';
import { useUi } from '../../store/ui';
import { isMixFlat, mixerTracks, soloActive } from '../../lib/mix';
import { tip } from '../shell/tip';
import { ScaleColumn } from './mixer/ScaleColumn';
import { Strip } from './mixer/Strip';
import './mixer/mixer.css';

/** the last mixerFocus this panel showed (n only grows), so a remount never flashes an old ask */
let seenN = 0;
const FLASH_MS = 600;

/** the mixer tab: one strip per track with sound, then the output strip */
export function MixerPanel() {
  const project = useEditor((s) => s.project);
  const flat = useEditor((s) => !s.project || isMixFlat(s.project));
  const solo = useSolo((s) => s.solo);
  const soloOn = useEditor((s) => soloActive(s.project, solo));
  const focus = useUi((s) => s.mixerFocus);
  // the tracks the selected clips are on, as one string so the selector stays equal until it really changes
  const currentKey = useEditor((s) => {
    const ids = new Set<string>();
    if (s.project && s.selection.length > 0) {
      const sel = new Set(s.selection);
      for (const c of s.project.clips) if (sel.has(c.id)) ids.add(c.trackId);
    }
    return [...ids].join(',');
  });
  const current = useMemo(() => new Set(currentKey ? currentKey.split(',') : []), [currentKey]);
  const tracks = useMemo(() => (project ? mixerTracks(project) : []), [project]);
  const row = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!focus || focus.n === seenN) return;
    seenN = focus.n;
    const want = focus.track ?? 'output';
    const el = [...(row.current?.querySelectorAll<HTMLElement>('[data-strip]') ?? [])].find((x) => x.dataset.strip === want);
    if (!el) return;
    el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    el.classList.add('is-flash');
    const timer = window.setTimeout(() => el.classList.remove('is-flash'), FLASH_MS);
    return () => {
      window.clearTimeout(timer);
      el.classList.remove('is-flash');
    };
  }, [focus]);

  return (
    <div className="mixer-tab">
      <div className="media-toolbar mixer-toolbar">
        <button
          type="button"
          className="btn btn-sm"
          disabled={flat}
          {...tip('reset', { does: 'every fader to 0 db and every pan to the middle, the output too. one undo step', why: 'mixer-reset' })}
          onClick={() => useEditor.getState().resetMixer()}
        >
          <RotateCcw size={13} />
          reset
        </button>
        {soloOn ? (
          <button
            type="button"
            className="btn btn-sm"
            {...tip('solo off', { does: 'hear every track again', why: 'solo-off' })}
            onClick={() => useSolo.getState().clearSolo()}
          >
            solo off
          </button>
        ) : null}
      </div>
      <div className="mixer-row" ref={row}>
        <ScaleColumn />
        {tracks.length === 0 ? (
          <div className="props-hint mixer-none">no tracks with sound yet. put a video with sound or an audio file on the timeline</div>
        ) : (
          tracks.map((t) => <Strip key={t.id} track={t} current={current.has(t.id)} />)
        )}
        <Strip track={null} current={false} />
      </div>
    </div>
  );
}
