/** shared by every tool file (src/mcp/tools/*). nothing here touches the dom, so the tools test in node */
import { useEditor, type ActionOpts } from '../store/editorStore';
import type { Clip, MediaAsset, Project, Track } from '../types';
import type { ToolResult } from './types';

/** something the client did wrong (unknown id, no project, a refused edit). the message goes back to it as is */
export class ToolError extends Error {}

/** a result holding data: objects go out as compact json, a string as it is */
export function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: typeof data === 'string' ? data : JSON.stringify(data) }] };
}

export function fail(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export const NO_PROJECT = 'no project is open. use list_projects and open_project, or create_project';

/** the open project, or a ToolError */
export function needProject(): Project {
  const p = useEditor.getState().project;
  if (!p) throw new ToolError(NO_PROJECT);
  return p;
}

export function needClip(id: unknown): Clip {
  const clip = needProject().clips.find((c) => c.id === id);
  if (!clip) throw new ToolError(`no clip with the id ${String(id)}. get_project lists the clips`);
  return clip;
}

export function needTrack(id: unknown): Track {
  const track = needProject().tracks.find((t) => t.id === id);
  if (!track) throw new ToolError(`no track with the id ${String(id)}. get_project lists the tracks`);
  return track;
}

export function needAsset(id: unknown): MediaAsset {
  const asset = needProject().assets.find((a) => a.id === id);
  if (!asset) throw new ToolError(`no media with the id ${String(id)}. get_project lists the media, import_media adds files`);
  return asset;
}

/** a clip on a locked track cannot be edited: say so instead of doing nothing */
export function needUnlocked(clip: Clip): void {
  const track = needProject().tracks.find((t) => t.id === clip.trackId);
  if (track?.locked) throw new ToolError(`the clip ${clip.id} is on the locked track ${track.id} (${track.name}). unlock it with update_track first`);
}

/**
 * several store actions as ONE undo step: `run` gets the options every action in it has to be called with.
 * (the store records the first change after pushHistory and nothing after it)
 */
export function oneStep<T>(run: (opts: ActionOpts) => T): T {
  useEditor.getState().pushHistory();
  return run({ skipHistory: true });
}

/** did the project change since `before`? most store actions return nothing, a refused edit just does nothing */
export function changedSince(before: Project): boolean {
  return useEditor.getState().project !== before;
}

/** 4 decimals are plenty for seconds and pixels, and keep the answers short */
export function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** a clip in one short line of data: what a client needs to pick it and place things around it */
export function clipBrief(clip: Clip): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: clip.id,
    type: clip.type,
    track: clip.trackId,
    start: round(clip.start),
    end: round(clip.start + clip.duration),
    name: clip.name,
  };
  if (clip.type === 'video' || clip.type === 'image' || clip.type === 'audio') out.asset = clip.assetId;
  if (clip.type === 'text') out.text = clip.text.length > 80 ? `${clip.text.slice(0, 80)}...` : clip.text;
  if (clip.type === 'shape') out.kind = clip.kind;
  if (clip.type === 'effect') {
    out.effect = clip.effect;
    if (clip.target) out.target = clip.target;
  }
  if ('threeD' in clip && clip.threeD) out.threeD = true;
  if ('shape' in clip && clip.shape && clip.shape !== 'plane') out.shape3d = clip.shape;
  if ('parent' in clip && clip.parent) out.parent = clip.parent;
  if (clip.keyframes && Object.keys(clip.keyframes).length > 0) out.keyed = Object.keys(clip.keyframes);
  if (clip.group) out.group = clip.group;
  return out;
}

/** a number argument that may be missing */
export function optNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function optString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** a list of ids from an argument (validate.ts already made sure of the shape) */
export function idList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
}
