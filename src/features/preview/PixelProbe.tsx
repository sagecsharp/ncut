/**
 * the pixel probe: hold alt over the picture in the output view to read the pixel under the pointer (rgb, hsl, luma
 * and hex). it works with the scopes closed, and in stage fullscreen. while it shows it holds a frame tap (so the
 * painters keep tapping, it asks for no extra picture) and re-reads the one pixel when the picture changes.
 */
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { useUi } from '../../store/ui';
import { usePlayback } from '../../store/playback';
import { isTypingTarget } from '../shell/useShortcuts';
import { probePixel, probePlace, probeShows, probeText } from './probe';
import { FrameReader } from './scopeRead';
import { scopeDelay } from './scopes';
import { addFrameTap } from './scopeTap';

export interface PixelProbeProps {
  canvasRef: RefObject<HTMLCanvasElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
}

export function PixelProbe({ canvasRef, stageRef }: PixelProbeProps) {
  const boxRef = useRef<HTMLDivElement>(null);
  const swatchRef = useRef<HTMLSpanElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const stage = stageRef.current;
    const box = boxRef.current;
    const swatch = swatchRef.current;
    const text = textRef.current;
    if (!stage || !box || !swatch || !text) return;
    let hovered = false;
    let alt = false;
    let buttons = 0;
    let pointer = { x: 0, y: 0 };
    let raf = 0;
    let timer = 0;
    let last = -Infinity;
    let cost = 0;
    let offTap: (() => void) | null = null;
    let reader: FrameReader | null = null;

    const hide = () => {
      if (box.hidden && !offTap && !reader && !timer) return;
      box.hidden = true;
      stage.classList.remove('is-probing');
      offTap?.();
      offTap = null;
      reader?.dispose();
      reader = null;
      window.clearTimeout(timer);
      timer = 0;
    };

    const update = () => {
      raf = 0;
      const canvas = canvasRef.current;
      if (!hovered || !canvas || !probeShows(alt, buttons, useUi.getState().previewMode)) return hide();
      const px = probePixel(pointer.x, pointer.y, canvas.getBoundingClientRect(), canvas.width, canvas.height);
      if (!px) return hide();
      if (!offTap) offTap = addFrameTap(onTap, false);
      reader ??= new FrameReader();
      const t0 = performance.now();
      const img = reader.read(canvas, px.x, px.y, 1, 1, 1, 1);
      if (!img) return hide();
      last = performance.now();
      cost = cost * 0.8 + (last - t0) * 0.2;
      const [r, g, b] = [img.data[0]!, img.data[1]!, img.data[2]!];
      text.textContent = probeText(r, g, b).join('\n');
      swatch.style.background = `rgb(${r}, ${g}, ${b})`;
      box.hidden = false;
      stage.classList.add('is-probing');
      const area = stage.getBoundingClientRect();
      const at = probePlace(pointer.x - area.left, pointer.y - area.top, box.offsetWidth, box.offsetHeight, area.width, area.height);
      box.style.transform = `translate(${at.x}px, ${at.y}px)`;
    };
    const request = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    // the picture changed under the pointer: read again, no more often than the scopes do
    function onTap(_image: unknown, _w: number, _h: number, kind: string) {
      if (kind !== 'output' || timer || raf) return;
      const wait = scopeDelay(performance.now(), last, usePlayback.getState().playing, cost);
      timer = window.setTimeout(() => {
        timer = 0;
        request();
      }, wait);
    }

    const onMove = (e: PointerEvent) => {
      pointer = { x: e.clientX, y: e.clientY };
      alt = e.altKey;
      buttons = e.buttons;
      if (alt || !box.hidden) request();
    };
    const onDown = (e: PointerEvent) => {
      buttons = e.buttons || 1;
      if (e.altKey || !box.hidden) request();
    };
    const onUp = (e: PointerEvent) => {
      buttons = e.buttons;
      request();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Alt') return;
      alt = e.type === 'keydown';
      // chrome on windows focuses its menu on a lone alt: over the picture the page keeps the focus
      if (!isTypingTarget(e.target)) e.preventDefault();
      if (!e.repeat) request();
    };
    const onBlur = () => {
      alt = false;
      request();
    };
    const onEnter = (e: PointerEvent) => {
      hovered = true;
      pointer = { x: e.clientX, y: e.clientY };
      alt = e.altKey;
      buttons = e.buttons;
      window.addEventListener('keydown', onKey);
      window.addEventListener('keyup', onKey);
      window.addEventListener('blur', onBlur);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('pointercancel', onUp);
    };
    const detach = () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    const onLeave = () => {
      hovered = false;
      alt = false;
      detach();
      hide();
    };

    stage.addEventListener('pointerenter', onEnter);
    stage.addEventListener('pointermove', onMove, { passive: true });
    stage.addEventListener('pointerdown', onDown, { passive: true });
    stage.addEventListener('pointerleave', onLeave);
    const offMode = useUi.subscribe((s, p) => {
      if (s.previewMode !== p.previewMode) request();
    });
    return () => {
      stage.removeEventListener('pointerenter', onEnter);
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerdown', onDown);
      stage.removeEventListener('pointerleave', onLeave);
      detach();
      offMode();
      cancelAnimationFrame(raf);
      hide();
    };
  }, [canvasRef, stageRef]);

  return (
    <div ref={boxRef} className="scopes-probe" hidden aria-hidden="true">
      <span ref={swatchRef} className="scopes-probe-swatch" />
      <span ref={textRef} />
    </div>
  );
}
