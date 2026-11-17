import { useEffect, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { DND_MIME, beginDrag, endDrag, getDragPayload, isNcutDrag } from '../../lib/dnd';
import type { DragPayload } from '../../lib/dnd';
import { marksOf } from '../../lib/marks';
import { getAssetUrl } from '../../media/registry';
import { getWaveform } from '../../media/derived';
import { useEditor } from '../../store/editorStore';
import { useSource } from '../../store/source';
import { REASON_TEXT } from '../shell/reasons';
import { SourceEdits } from './SourceEdits';
import { SourcePlayer, stillFor } from './sourcePlayer';
import { drawPeaks, peakColumns } from './sourceDraw';
import { SourceScrub } from './SourceScrub';
import { SourceTransport } from './SourceTransport';
import { frameTapOn, onTapWanted, tapFrame } from './scopeTap';
import { openInSource } from './sourceKeys';

type RvfcElement = HTMLVideoElement & {
  requestVideoFrameCallback?: (cb: (now: number, meta?: { mediaTime?: number }) => void) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

function readPayload(e: DragEvent): DragPayload | null {
  const live = getDragPayload();
  if (live) return live;
  try {
    const raw = e.dataTransfer.getData(DND_MIME);
    return raw ? (JSON.parse(raw) as DragPayload) : null;
  } catch {
    return null;
  }
}

const tapNone = (): void => tapFrame(null, 0, 0, 'source', true);

/** the inside of the source pane: the media on the stage, its bar, its transport and the three point edit row */
export function SourceView() {
  const assetId = useSource((s) => s.assetId);
  const asset = useEditor((s) => (assetId ? (s.project?.assets.find((a) => a.id === assetId) ?? null) : null));
  const kind = asset?.kind ?? null;
  const url = assetId ? getAssetUrl(assetId) : undefined;
  const [failedId, setFailedId] = useState<string | null>(null);
  const failed = !!asset && (failedId === asset.id || !url);

  const stageRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const feedRef = useRef<HTMLCanvasElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const waveRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<SourcePlayer | null>(null);

  // the player of the shown video or sound file, and the scopes tap of the picture it shows
  useEffect(() => {
    if (!asset || failed || kind === 'image' || !kind) return;
    const el = videoRef.current ?? audioRef.current;
    if (!el) return;
    const id = asset.id;
    const isVideo = el instanceof HTMLVideoElement;
    const feedCanvas = feedRef.current;
    // the bar drag shows the feed's picture over the element while it is nearer to the wanted time
    let feedOn = false;
    let alive = true;
    let handle = 0;
    const v = el as RvfcElement;

    const frame = () => {
      handle = 0;
      if (!alive || feedOn || !isVideo || !frameTapOn() || v.readyState < 2) return;
      tapFrame(v, v.videoWidth, v.videoHeight, 'source', v.paused);
      arm();
    };
    const arm = () => {
      if (handle || !alive) return;
      if (typeof v.requestVideoFrameCallback === 'function') handle = v.requestVideoFrameCallback(frame);
    };
    const start = () => {
      if (handle && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(handle);
      handle = 0;
      if (isVideo) frame();
      else tapNone();
    };
    const onPicture = () => {
      const pic = playerRef.current?.feedPicture() ?? null;
      if (pic && feedCanvas) {
        if (feedCanvas.width !== pic.width) feedCanvas.width = pic.width;
        if (feedCanvas.height !== pic.height) feedCanvas.height = pic.height;
        feedCanvas.getContext('2d')?.drawImage(pic.image, 0, 0, pic.width, pic.height);
        feedCanvas.classList.add('is-on');
        feedOn = true;
        tapFrame(feedCanvas, pic.width, pic.height, 'source', true);
      } else if (feedOn) {
        feedOn = false;
        feedCanvas?.classList.remove('is-on');
        start();
      }
    };
    const onError = () => {
      setFailedId(id);
      tapNone();
    };

    // a player before this one (strict mode runs the effect twice) took the src off the element
    if (url && el.getAttribute('src') !== url) el.setAttribute('src', url);
    const player = new SourcePlayer(el, id, onPicture);
    playerRef.current = player;
    const offWanted = onTapWanted(start);
    for (const ev of ['seeked', 'loadeddata', 'pause']) el.addEventListener(ev, start);
    el.addEventListener('error', onError);
    start();
    return () => {
      alive = false;
      if (handle && typeof v.cancelVideoFrameCallback === 'function') v.cancelVideoFrameCallback(handle);
      handle = 0;
      offWanted();
      for (const ev of ['seeked', 'loadeddata', 'pause']) el.removeEventListener(ev, start);
      el.removeEventListener('error', onError);
      feedCanvas?.classList.remove('is-on');
      player.dispose();
      playerRef.current = null;
    };
  }, [asset?.id, kind, failed]);

  // a picture taps its img once decoded, a sound file, missing media or no media taps nothing
  useEffect(() => {
    const none = !asset || failed || kind === 'audio';
    if (!none && kind !== 'image') return;
    if (none) {
      tapNone();
      return onTapWanted(tapNone);
    }
    const img = imgRef.current;
    if (!img) return;
    const tap = () => {
      if (img.complete && img.naturalWidth > 0) tapFrame(img, img.naturalWidth, img.naturalHeight, 'source', true);
    };
    tap();
    img.addEventListener('load', tap);
    const off = onTapWanted(tap);
    return () => {
      img.removeEventListener('load', tap);
      off();
    };
  }, [asset?.id, kind, failed]);

  // the kept still shows at once until the video has its picture at that time
  useEffect(() => {
    const canvas = stillRef.current;
    const v = videoRef.current;
    if (!canvas || !v || kind !== 'video' || !assetId) return;
    const still = stillFor(assetId, useSource.getState().time);
    if (!still) return;
    canvas.width = still.width;
    canvas.height = still.height;
    canvas.getContext('2d')?.drawImage(still, 0, 0);
    canvas.classList.add('is-on');
    const hide = () => canvas.classList.remove('is-on');
    for (const ev of ['seeked', 'loadeddata', 'error']) v.addEventListener(ev, hide, { once: true });
    return () => {
      for (const ev of ['seeked', 'loadeddata', 'error']) v.removeEventListener(ev, hide);
      hide();
    };
  }, [assetId, kind]);

  // a sound file shows its waveform on the stage
  useEffect(() => {
    const canvas = waveRef.current;
    const stage = stageRef.current;
    if (!canvas || !stage || kind !== 'audio' || !asset) return;
    let alive = true;
    let data: Awaited<ReturnType<typeof getWaveform>> = null;
    const paint = () => {
      const ctx = canvas.getContext('2d');
      const w = Math.floor(stage.clientWidth);
      const h = Math.min(160, Math.floor(stage.clientHeight));
      if (!ctx || w <= 0 || h <= 0) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      if (!data || data.peaks.length === 0) return;
      ctx.fillStyle = getComputedStyle(canvas).color;
      drawPeaks(ctx, peakColumns(data.peaks, data.peaksPerSecond, asset.duration, w), 0, h);
    };
    void getWaveform(asset.id).then((d) => {
      if (!alive) return;
      data = d;
      paint();
    });
    const ro = new ResizeObserver(paint);
    ro.observe(stage);
    return () => {
      alive = false;
      ro.disconnect();
    };
  }, [asset?.id, kind]);

  // the stage is the handle of the media: drag it onto the timeline, the marked part when there is one
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    if (!asset) {
      e.preventDefault();
      return;
    }
    const range = marksOf(asset);
    beginDrag(e, { kind: 'asset', assetId: asset.id, ...(range ? { range } : {}) });
    const ghost = document.createElement('div');
    ghost.className = 'source-drag-ghost';
    ghost.textContent = asset.name;
    document.body.appendChild(ghost);
    e.dataTransfer.setDragImage(ghost, 12, 12);
    window.setTimeout(() => ghost.remove(), 0);
  };
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isNcutDrag(e) || getDragPayload()?.kind !== 'asset') return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    stageRef.current?.classList.add('is-drop');
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    if (e.relatedTarget instanceof Node && stageRef.current?.contains(e.relatedTarget)) return;
    stageRef.current?.classList.remove('is-drop');
  };
  // a drop here only opens a media: it does not put anything on the timeline
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    stageRef.current?.classList.remove('is-drop');
    if (!isNcutDrag(e)) return;
    e.preventDefault();
    const payload = readPayload(e);
    if (payload?.kind === 'asset') openInSource(payload.assetId);
  };

  const hint = !asset ? 'click a media card to see it here' : failed ? REASON_TEXT.sourceMissing : null;

  return (
    <>
      <div
        ref={stageRef}
        className={`source-stage${asset ? ' has-media' : ''}`}
        draggable={!!asset}
        onDragStart={onDragStart}
        onDragEnd={endDrag}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {asset && !failed && kind === 'video' ? <video key={asset.id} ref={videoRef} className="source-video" src={url} preload="auto" playsInline draggable={false} /> : null}
        {asset && !failed && kind === 'audio' ? <audio key={asset.id} ref={audioRef} src={url} preload="auto" hidden /> : null}
        {asset && !failed && kind === 'image' ? <img key={asset.id} ref={imgRef} className="source-img" src={url} alt="" draggable={false} /> : null}
        {kind === 'audio' && !failed ? <canvas ref={waveRef} className="source-wave" /> : null}
        <canvas ref={feedRef} className="source-feed" />
        <canvas ref={stillRef} className="source-still" />
        {asset ? <span className="source-name">{asset.name}</span> : null}
        {hint ? <div className="preview-hint">{hint}</div> : null}
      </div>
      <SourceScrub asset={asset} playerRef={playerRef} />
      <SourceTransport />
      <div className="source-edits">
        <SourceEdits />
      </div>
    </>
  );
}
