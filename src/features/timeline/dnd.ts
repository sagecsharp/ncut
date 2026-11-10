/**
 * drops onto the timeline: payloads dragged from the media panel (assets, text presets) and files
 * dragged in from the os. dragover only measures once per drag (cached geometry), coalesces to one
 * ghost update per animation frame and writes the ghost with a transform.
 */
import type { DragEvent as ReactDragEvent } from 'react';
import type { MediaAsset, TrackKind } from '../../types';
import { DEFAULT_CAMERA_DURATION, DEFAULT_EFFECT_DURATION, DEFAULT_SHAPE_DURATION, DEFAULT_IMAGE_DURATION, DEFAULT_TEXT_DURATION } from '../../lib/factory';
import { DND_MIME, getDragPayload, isFileDrag, isNcutDrag } from '../../lib/dnd';
import type { DragPayload } from '../../lib/dnd';
import { getEffect } from '../../engine/effects/registry';
import { getTransition } from '../../engine/transitions/registry';
import { transitionFor } from '../media/transitionApply';
import { CUT_EPS } from '../../lib/transitions';
import { isVisualClip } from '../../types';
import type { VisualClip } from '../../types';
import { snapToFrame } from '../../lib/time';
import { clipEnd, findFreeStart, snapTime } from '../../lib/timelineOps';
import { timelineSnapPoints } from './markers';
import { importFiles } from '../../media/importer';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { CLIP_INSET, HEADER_W, RULER_H, SNAP_PX, computeLayout, hitLane } from './layout';
import type { Layout } from './layout';
import type { GhostKind, Overlays } from './overlays';
import { view } from './view';

export interface DndEnv {
  getScroller(): HTMLElement | null;
  overlays: Overlays;
}

interface Target {
  start: number;
  duration: number;
  /** lane to place on, when the lane kind fits */
  trackId?: string;
  laneIndex?: number;
  /** lane under the pointer regardless of kind */
  hitIndex?: number;
  zone?: 'top' | 'bottom';
}

function kindOfPayload(payload: DragPayload, assets: MediaAsset[]): TrackKind | null {
  if (payload.kind === 'text' || payload.kind === 'shape' || payload.kind === 'effect' || payload.kind === 'camera') return 'video';
  // transitions go on a clip, not on a lane
  if (payload.kind === 'transition') return null;
  const asset = assets.find((a) => a.id === payload.assetId);
  if (!asset) return null;
  return asset.kind === 'audio' ? 'audio' : 'video';
}

function durationOfPayload(payload: DragPayload, assets: MediaAsset[]): number {
  if (payload.kind === 'text') {
    const d = payload.preset?.duration;
    return typeof d === 'number' && d > 0 ? d : DEFAULT_TEXT_DURATION;
  }
  if (payload.kind === 'shape') {
    const d = payload.preset?.duration;
    return typeof d === 'number' && d > 0 ? d : DEFAULT_SHAPE_DURATION;
  }
  if (payload.kind === 'effect') return DEFAULT_EFFECT_DURATION;
  if (payload.kind === 'camera') return DEFAULT_CAMERA_DURATION;
  if (payload.kind === 'transition') return 1;
  const asset = assets.find((a) => a.id === payload.assetId);
  if (!asset) return 1;
  return asset.kind === 'image' ? DEFAULT_IMAGE_DURATION : Math.max(asset.duration, 0.1);
}

function ghostKind(payload: DragPayload | null): GhostKind {
  switch (payload?.kind) {
    case 'text':
    case 'shape':
    case 'effect':
    case 'camera':
      return payload.kind;
    default:
      return 'asset';
  }
}

function ghostLabel(payload: DragPayload | null): string {
  if (!payload) return '';
  if (payload.kind === 'camera') return 'camera';
  if (payload.kind === 'shape') return payload.preset?.name ?? payload.preset?.kind ?? 'rect';
  if (payload.kind === 'transition') return getTransition(payload.transition)?.name ?? payload.transition;
  if (payload.kind !== 'effect') return '';
  return getEffect(payload.effect)?.name ?? payload.effect;
}

/** over the last part of a clip with another clip right behind it, the user means the cut */
const CUT_ZONE = 0.7

function readPayload(e: ReactDragEvent): DragPayload | null {
  const live = getDragPayload();
  if (live) return live;
  try {
    const raw = e.dataTransfer?.getData(DND_MIME);
    if (raw) return JSON.parse(raw) as DragPayload;
  } catch {
    // ignore
  }
  return null;
}

export function createDnd(env: DndEnv) {
  let geo: { left: number; top: number } | null = null;
  let points: number[] | null = null;
  let layout: Layout | null = null;
  let rafId = 0;
  let last: { cx: number; cy: number; payload: DragPayload | null } | null = null;

  function reset(): void {
    geo = null;
    points = null;
    layout = null;
    last = null;
    if (rafId) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
    env.overlays.setGhost(null);
    env.overlays.setHot(null);
    env.overlays.setSnap(null, 1);
  }

  function ensure(): boolean {
    const project = useEditor.getState().project;
    const el = env.getScroller();
    if (!project || !el) return false;
    if (!geo) {
      const r = el.getBoundingClientRect();
      geo = { left: r.left, top: r.top };
    }
    if (!points) points = timelineSnapPoints(project, [], [usePlayback.getState().time]);
    if (!layout) layout = computeLayout(project.tracks);
    return true;
  }

  /** where a payload dropped at the pointer would land. snaps start/end, resolves the free spot. */
  function resolve(cx: number, cy: number, payload: DragPayload | null, snap: boolean): Target | null {
    if (!ensure() || !geo || !points || !layout) return null;
    const st = useEditor.getState();
    const project = st.project;
    if (!project) return null;
    const zoom = st.zoom;
    const duration = payload ? durationOfPayload(payload, project.assets) : 0;
    let start = Math.max(0, (cx - geo.left - HEADER_W + view.scrollLeft) / zoom);
    if (snap && st.snapping) {
      const thr = SNAP_PX / zoom;
      const a = snapTime(start, points, thr);
      const b = duration > 0 ? snapTime(start + duration, points, thr) : { time: start + duration, hit: null };
      const da = a.hit === null ? Infinity : Math.abs(a.time - start);
      const db = b.hit === null ? Infinity : Math.abs(b.time - (start + duration));
      if (da <= db && a.hit !== null) start = a.time;
      else if (b.hit !== null) start = Math.max(0, b.time - duration);
    }
    start = snapToFrame(start, project.fps);
    const hit = hitLane(layout, cy - geo.top - RULER_H + view.scrollTop);
    const kind = payload ? kindOfPayload(payload, project.assets) : null;
    if (hit.type === 'zone') {
      const ok = kind && ((hit.where === 'top' && kind === 'video') || (hit.where === 'bottom' && kind === 'audio'));
      return { start, duration, zone: ok ? hit.where : undefined };
    }
    const track = project.tracks[hit.index];
    if (track && !track.locked && kind === track.kind) {
      const free = findFreeStart(project, track.id, start, duration);
      return { start: free, duration, trackId: track.id, laneIndex: hit.index, hitIndex: hit.index };
    }
    return { start, duration, hitIndex: hit.index };
  }

  /** the visual clip a transition dropped at the pointer would go to, and its lane */
  function resolveTransition(cx: number, cy: number): { clip: VisualClip; laneIndex: number } | null {
    if (!ensure() || !geo || !layout) return null;
    const st = useEditor.getState();
    const project = st.project;
    if (!project) return null;
    const hit = hitLane(layout, cy - geo.top - RULER_H + view.scrollTop);
    if (hit.type !== 'lane') return null;
    const track = project.tracks[hit.index];
    if (!track || track.locked || track.kind !== 'video') return null;
    const time = (cx - geo.left - HEADER_W + view.scrollLeft) / st.zoom;
    let under: VisualClip | null = null;
    for (const c of project.clips) {
      if (c.trackId !== track.id || !isVisualClip(c)) continue;
      if (time >= c.start && time < clipEnd(c)) {
        under = c;
        break;
      }
    }
    if (!under) return null;
    if (time >= under.start + under.duration * CUT_ZONE) {
      const end = clipEnd(under);
      for (const c of project.clips) {
        if (c.id !== under.id && c.trackId === track.id && isVisualClip(c) && Math.abs(c.start - end) <= CUT_EPS) {
          return { clip: c, laneIndex: hit.index };
        }
      }
    }
    return { clip: under, laneIndex: hit.index };
  }

  function updateGhost(): void {
    rafId = 0;
    if (!last) return;
    if (last.payload?.kind === 'transition') {
      const hit = resolveTransition(last.cx, last.cy);
      env.overlays.setHot(null);
      if (!hit || !layout) {
        env.overlays.setGhost(null);
        return;
      }
      const zoom = useEditor.getState().zoom;
      env.overlays.setGhost(
        {
          x: Math.round(hit.clip.start * zoom),
          y: layout.tops[hit.laneIndex]! + CLIP_INSET,
          w: hit.clip.duration * zoom,
          h: layout.heights[hit.laneIndex]! - CLIP_INSET * 2,
        },
        'transition',
        ghostLabel(last.payload),
      );
      return;
    }
    const target = resolve(last.cx, last.cy, last.payload, true);
    const zoom = useEditor.getState().zoom;
    if (!target || !layout) {
      env.overlays.setGhost(null);
      env.overlays.setHot(null);
      return;
    }
    env.overlays.setHot(target.zone ?? null);
    if (target.laneIndex !== undefined && target.duration > 0) {
      const top = layout.tops[target.laneIndex]!;
      env.overlays.setGhost(
        {
          x: Math.round(target.start * zoom),
          y: top + CLIP_INSET,
          w: target.duration * zoom,
          h: layout.heights[target.laneIndex]! - CLIP_INSET * 2,
        },
        ghostKind(last.payload),
        ghostLabel(last.payload),
      );
    } else {
      env.overlays.setGhost(null);
    }
  }

  function accepts(e: ReactDragEvent): boolean {
    return isNcutDrag(e) || isFileDrag(e);
  }

  function onDragEnter(e: ReactDragEvent): void {
    if (!accepts(e)) return;
    e.preventDefault();
    // fresh measurement for every drag session
    geo = null;
    points = null;
    layout = null;
  }

  function onDragOver(e: ReactDragEvent): void {
    if (!accepts(e)) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    last = { cx: e.clientX, cy: e.clientY, payload: isNcutDrag(e) ? getDragPayload() : null };
    if (!rafId) rafId = requestAnimationFrame(updateGhost);
  }

  function onDragLeave(e: ReactDragEvent): void {
    if (!accepts(e)) return;
    const next = e.relatedTarget as Node | null;
    if (next && e.currentTarget.contains(next)) return;
    reset();
  }

  function onDrop(e: ReactDragEvent): void {
    if (!accepts(e)) return;
    e.preventDefault();
    const cx = e.clientX;
    const cy = e.clientY;
    const files = isFileDrag(e) && !isNcutDrag(e) ? Array.from(e.dataTransfer?.files ?? []) : [];
    const payload = readPayload(e);
    const transitionTarget = payload?.kind === 'transition' ? resolveTransition(cx, cy) : null;
    const target = resolve(cx, cy, payload, true);
    const fileTarget = files.length > 0 ? resolve(cx, cy, null, false) : null;
    reset();
    const st = useEditor.getState();
    if (!st.project) return;

    if (payload?.kind === 'transition') {
      // dropping on empty space, audio, effect or camera clips does nothing
      if (transitionTarget) {
        st.updateClip(transitionTarget.clip.id, { transition: transitionFor(payload.transition, transitionTarget.clip.transition) });
        st.select([transitionTarget.clip.id], 'replace');
      }
      return;
    }

    if (payload && target) {
      const kind = kindOfPayload(payload, st.project.assets);
      if (!kind) return;
      const index = target.zone === 'top' ? 0 : undefined;
      if (target.zone) {
        st.pushHistory();
        const trackId = st.addTrack(kind, { skipHistory: true, index });
        if (payload.kind === 'asset') st.insertAsset(payload.assetId, { trackId, start: target.start, skipHistory: true });
        else if (payload.kind === 'effect') st.addEffect(payload.effect, { trackId, start: target.start, skipHistory: true });
        else if (payload.kind === 'camera') st.addCamera({ trackId, start: target.start, skipHistory: true });
        else if (payload.kind === 'shape') st.addShape({ trackId, start: target.start, preset: payload.preset, skipHistory: true });
        else st.addText({ trackId, start: target.start, preset: payload.preset, skipHistory: true });
      } else if (payload.kind === 'asset') {
        st.insertAsset(payload.assetId, { trackId: target.trackId, start: target.start });
      } else if (payload.kind === 'effect') {
        st.addEffect(payload.effect, { trackId: target.trackId, start: target.start });
      } else if (payload.kind === 'camera') {
        st.addCamera({ trackId: target.trackId, start: target.start });
      } else if (payload.kind === 'shape') {
        st.addShape({ trackId: target.trackId, start: target.start, preset: payload.preset });
      } else {
        st.addText({ trackId: target.trackId, start: target.start, preset: payload.preset });
      }
      return;
    }

    if (files.length > 0 && fileTarget) {
      const tr = fileTarget.hitIndex !== undefined ? st.project.tracks[fileTarget.hitIndex] : undefined;
      void dropFiles(files, fileTarget.start, tr && !tr.locked ? { id: tr.id, kind: tr.kind } : undefined);
    }
  }

  /** import os files, then lay the resulting assets out one after another from the drop time */
  async function dropFiles(
    files: File[],
    dropStart: number,
    laneTrack: { id: string; kind: TrackKind } | undefined,
  ): Promise<void> {
    let assets: MediaAsset[];
    try {
      assets = await importFiles(files);
    } catch (err) {
      useUi.getState().toast(err instanceof Error ? err.message : 'import failed', 'error');
      return;
    }
    if (assets.length === 0) return;
    const st = useEditor.getState();
    if (!st.project) return;
    st.pushHistory();
    let t = dropStart;
    for (const asset of assets) {
      const kind: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
      const id = useEditor
        .getState()
        .insertAsset(asset.id, {
          trackId: laneTrack && laneTrack.kind === kind ? laneTrack.id : undefined,
          start: t,
          skipHistory: true,
        });
      if (!id) continue;
      const clip = useEditor.getState().project?.clips.find((c) => c.id === id);
      if (clip) t = clipEnd(clip);
    }
  }

  return { onDragEnter, onDragOver, onDragLeave, onDrop, dispose: reset };
}

export type Dnd = ReturnType<typeof createDnd>;
