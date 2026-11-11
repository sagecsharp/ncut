/** helpers of the tool tests (add / edit / keys): a fresh project in the real store, and a way to call a tool by name */
import { createProject } from '../../lib/factory';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import type { Clip, MediaAsset } from '../../types';
import { callTool } from '../registry';
import type { ToolResult } from '../types';

export const ed = () => useEditor.getState();
export const proj = () => useEditor.getState().project!;
export const clipOf = (id: string): Clip => proj().clips.find((c) => c.id === id)!;

/** a project with one video track (and one audio track) and the playhead at 0 */
export function fresh(): { video: string; audio: string } {
  ed().openProject(createProject());
  usePlayback.getState().seek(0);
  const video = ed().addTrack('video');
  const audio = ed().addTrack('audio');
  return { video, audio };
}

export function addVideoAsset(id = 'vid1', duration = 20): MediaAsset {
  const asset: MediaAsset = { id, name: id, kind: 'video', mime: 'video/mp4', size: 1, duration, width: 1920, height: 1080, hasAudio: true, createdAt: 0 };
  ed().addAsset(asset);
  return asset;
}

/** a video clip on a track, made through the store */
export function addVideoClip(trackId: string, start: number, assetId = 'vid1'): string {
  if (!proj().assets.some((a) => a.id === assetId)) addVideoAsset(assetId);
  const id = ed().insertAsset(assetId, { trackId, start });
  if (!id) throw new Error('could not add the clip');
  return id;
}

export type Answer = { ok: boolean; text: string; data: any };

export async function call(name: string, args: Record<string, unknown> = {}): Promise<Answer> {
  const r = (await callTool(name, args)) as ToolResult;
  const first = r.content[0];
  const text = first && first.type === 'text' ? first.text : '';
  let data: unknown = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* an error sentence */
  }
  return { ok: !r.isError, text, data };
}

/** runs `run` and checks it made exactly one undo step that one undo() takes back */
export async function oneStepOf(run: () => Promise<Answer>): Promise<Answer> {
  const before = proj();
  const n = ed().past.length;
  const r = await run();
  if (!r.ok) throw new Error(`tool failed: ${r.text}`);
  if (ed().past.length !== n + 1) throw new Error(`expected 1 undo step, got ${ed().past.length - n}`);
  const after = proj();
  ed().undo();
  if (proj() !== before && JSON.stringify(proj().clips) !== JSON.stringify(before.clips)) throw new Error('undo did not bring the project back');
  if (ed().past.length !== n) throw new Error('undo left a step behind');
  ed().redo();
  void after;
  return r;
}

/** a refused call changed nothing and left no undo step */
export async function refused(name: string, args: Record<string, unknown>, match: RegExp): Promise<void> {
  const before = proj();
  const n = ed().past.length;
  const r = await call(name, args);
  if (r.ok) throw new Error(`${name} should have been refused`);
  if (!match.test(r.text)) throw new Error(`error text "${r.text}" does not match ${match}`);
  if (ed().past.length !== n) throw new Error(`a refused ${name} left ${ed().past.length - n} undo steps`);
  if (JSON.stringify(proj().clips) !== JSON.stringify(before.clips)) throw new Error(`a refused ${name} changed the clips`);
}
