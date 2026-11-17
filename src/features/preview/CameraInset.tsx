/**
 * the camera inset: while the scene view is on, a small picture of what the output looks like right now (what
 * the project's camera sees), like the camera preview of a game engine's scene window. clicking it leaves the
 * scene view.
 *
 * it renders with the same renderFrame the output uses, small (240 css px, scaled by the preview quality), on its
 * own canvas and its own render channel ('inset', see setCanvasChannel: its gl contexts and scratch canvases are not shared
 * with the main preview), right after the main render has finished (everything is synchronous, so it cannot disturb it).
 * pace: at most ~10 per second while playing, once per change while paused (plus one settling render a moment
 * later for late video frames). nothing runs when the scene view or the inset is off: the body is not mounted.
 *
 * the media sources come from the preview engine (its resolver is private, see getResolve in Preview.tsx).
 */
import { useEffect, useRef } from 'react';
import { releaseRenderResources, renderFrame, setCanvasChannel } from '../../engine/draw';
import type { SourceResolver } from '../../engine/draw';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { tip } from '../shell/tip';
import { INSET_SETTLE_MS, insetBackingSize, insetCssSize, insetDelay, useCameraInset } from './insetState';
import { usePreviewQuality } from './quality';
import { LIVE_SAMPLE } from './scopes';
import { onTapWanted, tapFrame } from './scopeTap';
import { useScopes } from './scopesState';
import { onLutChange } from '../../media/lutTables';

function leaveSceneView(): void {
  useUi.getState().setPreviewMode('output');
}

function InsetBody({ getResolve, onSkyReady, hidden }: { getResolve: () => SourceResolver | null; onSkyReady?: (f: () => void) => () => void; hidden: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const hasProject = useEditor((s) => !!s.project);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasProject) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    // its own gpu contexts + scratch canvases: at 240 px next to the main picture they would otherwise be resized
    // back and forth between the two sizes on every render
    setCanvasChannel(canvas, 'inset');
    let disposed = false;
    let raf = 0;
    let timer = 0;
    let settle = 0;
    let last = -Infinity;

    const draw = () => {
      const project = useEditor.getState().project;
      const resolve = getResolve();
      if (!project || !resolve) return;
      const { time, playing } = usePlayback.getState();
      const css = insetCssSize(project.width, project.height);
      canvas.style.aspectRatio = `${css.w} / ${css.h}`;
      const size = insetBackingSize(project.width, project.height, window.devicePixelRatio || 1, usePreviewQuality.getState().quality, useScopes.getState().open ? LIVE_SAMPLE : 0);
      // assigning width / height clears the canvas: only when the size really changes
      if (canvas.width !== size.w) canvas.width = size.w;
      if (canvas.height !== size.h) canvas.height = size.h;
      ctx.setTransform(canvas.width / project.width, 0, 0, canvas.height / project.height, 0, 0);
      try {
        // while playing the motion blur uses fewer samples, like the main picture
        renderFrame(ctx, project, time, resolve, { quality: playing ? 0.5 : 1 });
        // the scopes measure this picture in the scene view (nothing listens while they are closed)
        tapFrame(canvas, canvas.width, canvas.height, 'scene', !playing);
      } catch {
        // a clip that cannot draw must not take the scene view down with it
      }
    };

    const run = () => {
      raf = 0;
      timer = 0;
      if (disposed) return;
      last = performance.now();
      draw();
      window.clearTimeout(settle);
      settle = 0;
      if (!usePlayback.getState().playing) {
        // a video frame or an image that arrives a moment after the edit
        settle = window.setTimeout(() => {
          settle = 0;
          if (!disposed && !usePlayback.getState().playing) draw();
        }, INSET_SETTLE_MS);
      }
    };

    const request = () => {
      if (disposed || raf || timer) return;
      const wait = insetDelay(performance.now(), last, usePlayback.getState().playing);
      if (wait <= 0) raf = requestAnimationFrame(run);
      else timer = window.setTimeout(run, wait);
    };

    const offs = [
      usePlayback.subscribe((s, p) => {
        if (s.time !== p.time || s.playing !== p.playing) request();
      }),
      useEditor.subscribe((s, p) => {
        if (s.project !== p.project) request();
      }),
      usePreviewQuality.subscribe((s, p) => {
        if (s.quality !== p.quality) request();
      }),
      // the scopes or the probe want a picture, or the scopes opened or closed (the size changes)
      onTapWanted(request),
      useScopes.subscribe((s, p) => {
        if (s.open !== p.open) request();
      }),
    ];
    // the sky pictures finish loading after the first draw: draw again with them
    const offSky = onSkyReady?.(request);
    // a lut table finishes reading after the first draw too
    const offLut = onLutChange(request);
    request();

    return () => {
      disposed = true;
      for (const off of offs) off();
      offSky?.();
      offLut();
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.clearTimeout(settle);
      // the inset is off (or the scene view left): give its canvases and contexts back
      releaseRenderResources('inset');
      setCanvasChannel(canvas, 'default');
    };
  }, [hasProject, getResolve, onSkyReady]);

  if (!hasProject) return null;
  return (
    <button type="button" className={`scene-inset${hidden ? ' is-hidden' : ''}`} {...tip('output inset', { does: 'what the export shows. click to go back to the output' })} aria-label="output inset: leave the scene view" onClick={leaveSceneView}>
      <canvas ref={canvasRef} className="scene-inset-canvas" />
      <span className="scene-inset-label">camera</span>
    </button>
  );
}

export function CameraInset({ getResolve, onSkyReady }: { getResolve: () => SourceResolver | null; onSkyReady?: (f: () => void) => () => void }) {
  const scene = useUi((s) => s.previewMode === 'scene');
  const on = useCameraInset((s) => s.on);
  const scopesOpen = useScopes((s) => s.open);
  // with the inset off the scopes still measure the output through it: it renders hidden
  if (!scene || !(on || scopesOpen)) return null;
  return <InsetBody getResolve={getResolve} onSkyReady={onSkyReady} hidden={!on} />;
}
