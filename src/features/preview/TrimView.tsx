/**
 * the two frame view (trim 4.5): while a trim is dragged, and 1.5 s after a key trim, two frames sit over the stage:
 * what ends on the left of the edit and what starts on the right. null when idle.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { getAssetUrl } from '../../media/registry';
import { seekFrame } from '../../media/seekFrame';
import { useEditor } from '../../store/editorStore';
import { getTrimView, subscribeTrimView, trimSides } from '../timeline/trimLive';
import type { TrimSide, TrimViewReq } from '../timeline/trimLive';
import './trimView.css';

const RELEASE_MS = 3000;
const SEEK_TIMEOUT_MS = 2000;
const CANVAS_W = 640;
const CANVAS_H = 360;

/**
 * the private videos of the two halves and the stills, kept at module level so a drag that stops and starts again
 * does not load the media again. they are released 3 s after the view hides
 */
interface Slot {
  video: HTMLVideoElement | null;
  assetId: string;
  /** one seek in flight per side: the newest wish waits here */
  want: { time: number; canvas: HTMLCanvasElement } | null;
  busy: boolean;
}
const slots: [Slot, Slot] = [
  { video: null, assetId: '', want: null, busy: false },
  { video: null, assetId: '', want: null, busy: false },
];
const stills = new Map<string, HTMLImageElement>();
let releaseTimer: ReturnType<typeof setTimeout> | null = null;

function keep(): void {
  if (releaseTimer !== null) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
  }
}

function dropVideo(s: Slot): void {
  const v = s.video;
  s.video = null;
  s.assetId = '';
  s.want = null;
  if (!v) return;
  v.pause();
  v.removeAttribute('src');
  v.load();
}

function release(): void {
  releaseTimer = null;
  for (const s of slots) dropVideo(s);
  stills.clear();
}

function releaseLater(): void {
  keep();
  releaseTimer = setTimeout(release, RELEASE_MS);
}

function videoOf(s: Slot, assetId: string): HTMLVideoElement | null {
  if (s.video && s.assetId === assetId) return s.video;
  dropVideo(s);
  const url = getAssetUrl(assetId);
  if (!url) return null;
  const v = document.createElement('video');
  v.muted = true;
  v.playsInline = true;
  v.preload = 'auto';
  v.src = url;
  s.video = v;
  s.assetId = assetId;
  return v;
}

/** the picture inside the canvas, as large as fits with its own shape */
function paint(canvas: HTMLCanvasElement, src: CanvasImageSource, w: number, h: number): void {
  const ctx = canvas.getContext('2d');
  if (!ctx || w <= 0 || h <= 0) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const k = Math.min(canvas.width / w, canvas.height / h);
  const dw = w * k;
  const dh = h * k;
  ctx.drawImage(src, (canvas.width - dw) / 2, (canvas.height - dh) / 2, dw, dh);
}

function loaded(v: HTMLVideoElement): Promise<void> {
  if (v.readyState >= 1) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => {
      window.clearTimeout(timer);
      v.removeEventListener('loadedmetadata', done);
      v.removeEventListener('error', done);
      resolve();
    };
    const timer = window.setTimeout(done, SEEK_TIMEOUT_MS);
    v.addEventListener('loadedmetadata', done);
    v.addEventListener('error', done);
  });
}

/** one seek at a time: while it runs only the newest wish is kept, and it runs next */
async function pump(i: 0 | 1): Promise<void> {
  const s = slots[i];
  if (s.busy) return;
  s.busy = true;
  try {
    while (s.want) {
      const w = s.want;
      s.want = null;
      const v = s.video;
      if (!v) continue;
      await loaded(v);
      if (!(await seekFrame(v, w.time, SEEK_TIMEOUT_MS)) || !w.canvas.isConnected || v !== s.video) continue;
      paint(w.canvas, v, v.videoWidth, v.videoHeight);
    }
  } finally {
    s.busy = false;
  }
}

function drawSide(i: 0 | 1, side: TrimSide, canvas: HTMLCanvasElement): void {
  if (side.show === 'video' && side.assetId) {
    const s = slots[i];
    if (!videoOf(s, side.assetId)) return;
    s.want = { time: side.time, canvas };
    void pump(i);
  } else if (side.show === 'image' && side.assetId) {
    const id = side.assetId;
    let img = stills.get(id);
    if (!img) {
      const url = getAssetUrl(id);
      if (!url) return;
      img = new Image();
      img.src = url;
      stills.set(id, img);
    }
    const im = img;
    if (im.complete && im.naturalWidth > 0) paint(canvas, im, im.naturalWidth, im.naturalHeight);
    else im.addEventListener('load', () => { if (canvas.isConnected) paint(canvas, im, im.naturalWidth, im.naturalHeight); }, { once: true });
  }
}

function Half({ index, side }: { index: 0 | 1; side: TrimSide }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const picture = side.show === 'video' || side.show === 'image';
  const key = `${side.show}|${side.assetId ?? ''}|${side.time}`;
  useEffect(() => {
    const canvas = ref.current;
    if (canvas) drawSide(index, side, canvas);
    // the side is a new object every render, its key says whether it changed
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, key]);
  return (
    <div className="preview-trimview-half">
      {picture ? <canvas ref={ref} className="preview-trimview-canvas" width={CANVAS_W} height={CANVAS_H} /> : <div className="preview-trimview-blank" />}
      <div className="preview-trimview-label">{side.label}</div>
    </div>
  );
}

/** subscribes to the project only while it shows */
function Shown({ req }: { req: TrimViewReq }) {
  const project = useEditor((s) => s.project);
  useEffect(() => {
    keep();
    return releaseLater;
  }, []);
  const sides = project ? trimSides(project, req, project.fps) : null;
  if (!sides) return null;
  return (
    <div className="preview-trimview" aria-hidden="true">
      <Half index={0} side={sides[0]} />
      <Half index={1} side={sides[1]} />
    </div>
  );
}

export function TrimView() {
  const req = useSyncExternalStore(subscribeTrimView, getTrimView);
  return req ? <Shown req={req} /> : null;
}
