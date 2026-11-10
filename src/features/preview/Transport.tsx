import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Maximize, Minimize, Pause, Play, Repeat, SkipBack, SkipForward, StepBack, StepForward, Volume1, Volume2, VolumeX } from 'lucide-react';
import { formatTimecode } from '../../lib/time';
import { projectDuration } from '../../lib/timelineOps';
import { useEditor } from '../../store/editorStore';
import { useFloatingMenu } from '../timeline/menuBehavior';
import { usePlayback } from '../../store/playback';
import './transport.css';

const SPEEDS: readonly number[] = [0.25, 0.5, 1, 1.5, 2];

const rateLabel = (n: number) => `${+n.toFixed(2)}x`;

function SpeedMenu({ x, y, onClose }: { x: number; y: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const speed = usePlayback((s) => s.speed);
  const pos = useFloatingMenu(ref, x, y, onClose);
  // keyboard: focus the current choice on open, arrows move, escape closes (useFloatingMenu)
  useEffect(() => {
    const items = ref.current?.querySelectorAll<HTMLButtonElement>('button');
    const i = SPEEDS.indexOf(speed);
    items?.[i >= 0 ? i : 2]?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus();
  };
  return (
    <div ref={ref} className="menu preview-speed-menu" style={{ left: pos.x, top: pos.y }} role="menu" onKeyDown={onKeyDown}>
      {SPEEDS.map((v) => (
        <button
          key={v}
          className="menu-item"
          role="menuitemradio"
          aria-checked={speed === v}
          title={`play the preview at ${rateLabel(v)}`}
          onClick={() => {
            usePlayback.getState().setSpeed(v);
            onClose();
          }}
        >
          {rateLabel(v)}
          {speed === v && <span className="menu-hint">on</span>}
        </button>
      ))}
    </div>
  );
}

interface Props {
  fullscreen: boolean;
  onToggleFullscreen(): void;
}

export const Transport = memo(function Transport({ fullscreen, onToggleFullscreen }: Props) {
  const playing = usePlayback((s) => s.playing);
  const loop = usePlayback((s) => s.loop);
  const volume = usePlayback((s) => s.volume);
  const muted = usePlayback((s) => s.muted);
  const speed = usePlayback((s) => s.speed);
  // the live rate: only differs from the picked speed while a j / l shuttle runs
  const rate = usePlayback((s) => (s.playing ? s.rate : s.speed));
  const [speedMenu, setSpeedMenu] = useState<{ x: number; y: number } | null>(null);
  const closeSpeed = useCallback(() => setSpeedMenu(null), []);
  const fps = useEditor((s) => s.project?.fps ?? 30);
  const total = useEditor((s) => (s.project ? projectDuration(s.project) : 0));
  const hasClips = total > 0;

  const timeRef = useRef<HTMLSpanElement>(null);
  const totalText = formatTimecode(total, fps);

  // the current time is written straight to the dom: it changes every frame while playing
  useEffect(() => {
    let last = '';
    const write = (t: number) => {
      const text = formatTimecode(t, fps);
      if (text !== last && timeRef.current) {
        timeRef.current.textContent = text;
        last = text;
      }
    };
    write(usePlayback.getState().time);
    return usePlayback.subscribe((s, prev) => {
      if (s.time !== prev.time) write(s.time);
    });
  }, [fps]);

  const pb = usePlayback.getState;
  const shownVolume = muted ? 0 : volume;
  const VolumeIcon = shownVolume === 0 ? VolumeX : shownVolume < 0.5 ? Volume1 : Volume2;

  return (
    <div className="preview-transport">
      <button className="icon-btn" title="jump to start" aria-label="jump to start" onClick={() => { pb().pause(); pb().seek(0); }}>
        <SkipBack size={16} />
      </button>
      <button className="icon-btn" title="previous frame" aria-label="previous frame" onClick={() => pb().stepFrames(-1)}>
        <StepBack size={16} />
      </button>
      <button
        className="btn btn-primary preview-play"
        title={playing ? 'pause' : 'play'}
        aria-label={playing ? 'pause' : 'play'}
        disabled={!hasClips}
        onClick={() => pb().toggle()}
      >
        {playing ? <Pause size={16} /> : <Play size={16} />}
      </button>
      <button className="icon-btn" title="next frame" aria-label="next frame" onClick={() => pb().stepFrames(1)}>
        <StepForward size={16} />
      </button>
      <button
        className="icon-btn"
        title="jump to end"
        aria-label="jump to end"
        onClick={() => {
          const p = useEditor.getState().project;
          pb().pause();
          pb().seek(p ? projectDuration(p) : 0);
        }}
      >
        <SkipForward size={16} />
      </button>
      <button
        className={`icon-btn${loop ? ' is-active' : ''}`}
        title={loop ? 'loop on' : 'loop off'}
        aria-label="toggle loop"
        aria-pressed={loop}
        onClick={() => pb().setLoop(!loop)}
      >
        <Repeat size={16} />
      </button>

      <button
        className={`btn preview-speed mono${rate !== speed ? ' is-shuttle' : ''}`}
        title="preview speed (export is not affected)"
        aria-label={`preview speed ${rateLabel(rate)}`}
        aria-haspopup="menu"
        aria-expanded={speedMenu !== null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          // the transport sits at the bottom: open upwards (the menu clamps itself into the window)
          setSpeedMenu((m) => (m ? null : { x: r.left, y: r.top - SPEEDS.length * 30 - 8 }));
        }}
      >
        {rateLabel(rate)}
      </button>
      {speedMenu && <SpeedMenu x={speedMenu.x} y={speedMenu.y} onClose={closeSpeed} />}

      <div className="preview-time mono" title="current time / total duration">
        <span ref={timeRef}>{formatTimecode(0, fps)}</span>
        <span className="preview-time-sep">/</span>
        <span className="preview-time-total">{totalText}</span>
      </div>

      <div className="preview-spacer" />

      <button
        className="icon-btn"
        title={shownVolume === 0 ? 'unmute' : 'mute'}
        aria-label="toggle mute"
        onClick={() => {
          if (muted && pb().volume === 0) pb().setVolume(1);
          pb().setMuted(!muted);
        }}
      >
        <VolumeIcon size={16} />
      </button>
      <input
        className="range preview-volume"
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={shownVolume}
        title="master volume"
        aria-label="master volume"
        onChange={(e) => {
          const v = Number(e.target.value);
          // never store 0: keep the last audible volume so the mute button can bring it back
          if (v > 0) {
            pb().setVolume(v);
            pb().setMuted(false);
          } else pb().setMuted(true);
        }}
      />
      <button
        className="icon-btn"
        title={fullscreen ? 'exit fullscreen' : 'fullscreen'}
        aria-label="toggle fullscreen"
        onClick={onToggleFullscreen}
      >
        {fullscreen ? <Minimize size={16} /> : <Maximize size={16} />}
      </button>
    </div>
  );
});
