import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import { getFilmstrip } from '../../media/derived';
import type { MediaAsset } from '../../types';
import { SKIM_COUNT, SKIM_H, SKIM_REST_MS, coverRect, skimIndex, skimTime } from './cardMath';

/** one skim request in flight for all cards: a column of cards under a moving mouse does not queue a decode each */
let skimBusy = false;

interface Film {
  times: number[];
  frames: ImageBitmap[];
}

/**
 * the mouse over a video card shows its frames: the filmstrip the timeline drew (a cache hit when it is there), the frame
 * under the pointer, a line where it is. timeRef holds the time of that frame for the card's click, null when not skimming.
 * it listens on the thumbnail it sits in and draws on a canvas of its own.
 */
export function CardSkim({ asset, timeRef }: { asset: MediaAsset; timeRef: RefObject<number | null> }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;
    let alive = true;
    let timer = 0;
    let raf = 0;
    let film: Film | null = null;
    let x = -1;
    let line = '';

    const clear = () => {
      window.clearTimeout(timer);
      cancelAnimationFrame(raf);
      timer = 0;
      raf = 0;
      x = -1;
      timeRef.current = null;
      canvas.classList.remove('is-on');
    };

    const paint = () => {
      raf = 0;
      if (!film || x < 0) return;
      const w = Math.round(host.clientWidth);
      const h = Math.round(host.clientHeight);
      if (w <= 0 || h <= 0) return;
      const t = skimTime(x, w, asset.duration);
      const i = skimIndex(film.times, t);
      const frame = film.frames[i];
      const ctx = canvas.getContext('2d');
      if (!frame || !ctx) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      if (canvas.width !== Math.round(w * dpr)) canvas.width = Math.round(w * dpr);
      if (canvas.height !== Math.round(h * dpr)) canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      try {
        const c = coverRect(frame.width, frame.height, w, h);
        ctx.drawImage(frame, c.sx, c.sy, c.sw, c.sh, 0, 0, w, h);
      } catch {
        // the strip was closed under us: ask again next time
        film = null;
        return;
      }
      if (!line) line = getComputedStyle(canvas).color;
      ctx.fillStyle = line;
      ctx.fillRect(Math.min(w - 1, Math.max(0, Math.round(x))), 0, 1, h);
      canvas.classList.add('is-on');
      timeRef.current = t;
    };

    const load = () => {
      timer = 0;
      if (skimBusy || !alive) return;
      skimBusy = true;
      void getFilmstrip(asset.id, SKIM_COUNT, SKIM_H)
        .then((res) => {
          skimBusy = false;
          if (!alive || !res || res.frames.length === 0) return;
          film = res;
          if (x >= 0 && !raf) raf = requestAnimationFrame(paint);
        })
        .catch(() => {
          skimBusy = false;
        });
    };

    const onMove = (e: MouseEvent) => {
      x = e.clientX - host.getBoundingClientRect().left;
      if (film) {
        if (!raf) raf = requestAnimationFrame(paint);
        return;
      }
      // the strip is asked for once the mouse rests
      window.clearTimeout(timer);
      timer = window.setTimeout(load, SKIM_REST_MS);
    };

    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', clear);
    host.addEventListener('mousedown', clear);
    host.addEventListener('dragstart', clear);
    return () => {
      alive = false;
      clear();
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', clear);
      host.removeEventListener('mousedown', clear);
      host.removeEventListener('dragstart', clear);
    };
  }, [asset.id, asset.duration, timeRef]);

  return <canvas ref={canvasRef} className="media-skim" aria-hidden="true" />;
}
