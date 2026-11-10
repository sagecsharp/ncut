/**
 * drag and drop between the media panel and the timeline / preview.
 * html5 drag events hide the payload until `drop`, so the source also stores it here
 * and drop targets read it during dragover to draw an accurate ghost.
 */
import type { TextClip } from '../types';

export const DND_MIME = 'application/x-ncut';

export type DragPayload =
  | { kind: 'asset'; assetId: string }
  | { kind: 'text'; preset?: Partial<TextClip> };

let current: DragPayload | null = null;

/** call in onDragStart of the source */
export function beginDrag(e: { dataTransfer: DataTransfer | null }, payload: DragPayload): void {
  current = payload;
  if (e.dataTransfer) {
    e.dataTransfer.setData(DND_MIME, JSON.stringify(payload));
    e.dataTransfer.effectAllowed = 'copy';
  }
}

/** call in onDragEnd of the source */
export function endDrag(): void {
  current = null;
}

/** the payload of the drag in progress, or null (e.g. files dragged in from the os) */
export function getDragPayload(): DragPayload | null {
  return current;
}

/** true when the drag event carries one of our payloads */
export function isNcutDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes(DND_MIME);
}

/** true when the drag event carries files from the os */
export function isFileDrag(e: { dataTransfer: DataTransfer | null }): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files');
}
