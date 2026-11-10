/**
 * what a transition remembers about its two sides between frames. while a transition runs, one side is usually frozen on
 * its edge frame: its picture is the same every frame. the renderer paints a side into a scratch canvas and the runner
 * uploads that canvas into a gpu texture; both are skipped when the key of the picture is unchanged. a key is made only for
 * sides that are really constant (a frozen text, shape or image clip): everything that can change the pixels is in it,
 * and a side that cannot be proven constant gets no key and takes the full path every frame.
 */

const serials = new WeakMap<object, number>();
let serial = 0;

/** a number for an object that stays the same for its whole life (keys are strings, objects are compared by identity) */
export function objectSerial(o: object): number {
  let n = serials.get(o);
  if (n === undefined) {
    n = ++serial;
    serials.set(o, n);
  }
  return n;
}

/**
 * true when the picture of a side cannot change while its time is frozen: a text / shape / image clip that is drawn flat.
 * a video is never constant (the same frame object can hold another frame: the preview reuses its <video>, the exporter a
 * pooled canvas), a 3d clip depends on the camera at the frame time.
 */
export function constantSideKind(type: string, threeD: boolean | undefined, frozen: boolean): boolean {
  if (!frozen || threeD) return false;
  return type === 'text' || type === 'shape' || type === 'image';
}

export interface SideKeyInput {
  /** the stored clip object (identity: clips are replaced on every edit, never changed) */
  clip: object;
  /** the project, its clips array and its length (guards an in-place push), its tracks array */
  project: object;
  clips: object;
  clipCount: number;
  tracks: object;
  /** the time the side is painted at (its frozen edge), and the frame time that its effects are looked up at, clamped into the clip */
  paintTime: number;
  fxTime: number;
  /** the scratch canvas the side is painted into */
  width: number;
  height: number;
  /** the transform of that canvas' context (a, b, c, d, e, f) */
  matrix: readonly number[];
  channel: string;
  quality: number;
  /** the fonts version: text is drawn with other glyphs once a font arrives */
  fonts: number;
  /** an image clip's bitmap object and its pixel size, null for text and shape */
  image: { source: object; width: number; height: number } | null;
}

/** the key of a constant side's picture. two keys are equal only when every input above is. */
export function frozenSideKey(i: SideKeyInput): string {
  return [
    objectSerial(i.clip),
    objectSerial(i.project),
    objectSerial(i.clips),
    i.clipCount,
    objectSerial(i.tracks),
    i.paintTime,
    i.fxTime,
    i.width,
    i.height,
    i.matrix.join(','),
    i.channel,
    i.quality,
    i.fonts,
    i.image ? `${objectSerial(i.image.source)}:${i.image.width}x${i.image.height}` : '-',
  ].join('|');
}

/** the key each scratch canvas was last painted for (a canvas that is painted for no key, or resized, forgets it) */
export class SideMemo {
  private readonly keys = new WeakMap<object, string>();

  /** true when the canvas holds the picture for this key */
  holds(canvas: object, key: string | null): boolean {
    return key !== null && this.keys.get(canvas) === key;
  }

  /** the canvas holds the picture for this key now (null: it holds something no key describes) */
  set(canvas: object, key: string | null): void {
    if (key === null) this.keys.delete(canvas);
    else this.keys.set(canvas, key);
  }
}

/** true when the gpu texture still holds the picture of `key` (`stored` = the key of what was uploaded last) and the upload can be skipped */
export function textureHolds(stored: string | null, key: string | undefined): boolean {
  return key !== undefined && stored === key;
}
