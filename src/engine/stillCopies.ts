/**
 * the per clip copies of looked / masked still pictures that the flat (2d) path keeps between frames.
 * pure bookkeeping (no canvas is made here): a slot per clip + channel + step, a bounded number of entries and a
 * bounded number of pixels, oldest used goes first. an entry that leaves the cache has its canvas zeroed so the
 * backing store goes back right away. the 3d path has its own maps (lookCopies / maskCopies in draw.ts).
 */

/** what the cache needs of a canvas: its size, and that a zero size gives the memory back */
export interface SizedCanvas {
  width: number;
  height: number;
}

export interface StillEntry<C extends SizedCanvas> {
  /** the key of the picture the copy was made from (a still source's own key, or the key of the previous step's copy) */
  srcKey: string;
  /** what the processing depends on besides the picture (look / mask signature) */
  sig: string;
  /** the size the processing was asked at (not the size of the result) */
  w: number;
  h: number;
  canvas: C;
  /** the key of the copy itself: changes whenever the copy is rebuilt */
  key: string;
}

export class StillCopies<C extends SizedCanvas> {
  private readonly map = new Map<string, StillEntry<C>>();
  /** pixels each slot was counted with (the canvas is zeroed when it leaves, so its size can not be read then) */
  private readonly px = new Map<string, number>();
  private pixels = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxPixels: number,
  ) {}

  get size(): number {
    return this.map.size;
  }

  /** the pixels the cached canvases hold together */
  get totalPixels(): number {
    return this.pixels;
  }

  /** the entry of a slot when it was made from this picture and settings, or undefined. a hit becomes the newest. */
  hit(slot: string, srcKey: string, sig: string, w: number, h: number): StillEntry<C> | undefined {
    const e = this.map.get(slot);
    if (!e || e.srcKey !== srcKey || e.sig !== sig || e.w !== w || e.h !== h) return undefined;
    this.map.delete(slot);
    this.map.set(slot, e);
    return e;
  }

  /** the entry of a slot whatever it was made from (to reuse its canvas), without touching the order */
  peek(slot: string): StillEntry<C> | undefined {
    return this.map.get(slot);
  }

  /** put an entry in a slot (a canvas the slot held before and the new one are different objects or the same: both fine) */
  set(slot: string, entry: StillEntry<C>): void {
    const old = this.map.get(slot);
    if (old) {
      this.map.delete(slot);
      this.pixels -= this.px.get(slot) ?? 0;
      // the canvas is reused when the new copy is made into it: only give back one that is not the new one
      if (old.canvas !== entry.canvas) zero(old.canvas);
    }
    this.map.set(slot, entry);
    const n = area(entry.canvas);
    this.px.set(slot, n);
    this.pixels += n;
    // oldest first, never the entry just put in
    while (this.map.size > 1 && (this.map.size > this.maxEntries || this.pixels > this.maxPixels)) {
      const first = this.map.keys().next().value;
      if (first === undefined || first === slot) break;
      this.drop(first);
    }
  }

  /** forget one slot and give its canvas back */
  drop(slot: string): void {
    const e = this.map.get(slot);
    if (!e) return;
    this.map.delete(slot);
    this.pixels -= this.px.get(slot) ?? 0;
    this.px.delete(slot);
    zero(e.canvas);
  }

  /** forget every slot that starts with `prefix` */
  dropPrefix(prefix: string): void {
    for (const slot of [...this.map.keys()]) if (slot.startsWith(prefix)) this.drop(slot);
  }

  /** forget every slot the test says to */
  dropWhere(test: (slot: string) => boolean): void {
    for (const slot of [...this.map.keys()]) if (test(slot)) this.drop(slot);
  }

  clear(): void {
    for (const slot of [...this.map.keys()]) this.drop(slot);
  }
}

function area(c: SizedCanvas): number {
  return c.width * c.height;
}

function zero(c: SizedCanvas): void {
  c.width = 0;
  c.height = 0;
}

/**
 * one processing step (a look, a mask) of a still picture through the kept copies.
 * - a slot that holds a copy made from the same picture (`srcKey`), settings (`sig`) and asked size (`w` x `h`): the copy
 *   and its key come back, `run` is not called (no upload, no gpu work, no pixel copy).
 * - otherwise `run` makes the result the direct way. a result that is the picture itself comes back as it is, with the
 *   key it had. a result with a size is copied by `copy` into a canvas of its own size (it gets the slot's old canvas to
 *   reuse when that has the same size) and the copy is kept under a new key.
 * - `copy` returning null (no canvas to make here): the direct result, with no key, so a later step does not cache either.
 * the copy is made at the size of the direct result, never another one: it is drawn with the same arguments and gives
 * the same pixels.
 */
export function keptStep<I, C extends SizedCanvas>(
  cache: StillCopies<C>,
  slot: string,
  srcKey: string,
  sig: string,
  w: number,
  h: number,
  image: I,
  run: () => I | C,
  copy: (out: C, reuse: C | null) => C | null,
  nextKey: () => string,
): { image: I | C; key: string | undefined } {
  const hit = cache.hit(slot, srcKey, sig, w, h);
  if (hit) return { image: hit.canvas, key: hit.key };
  const out = run();
  if (out === image) return { image, key: srcKey };
  const oc = out as C;
  if (!(oc.width > 0 && oc.height > 0)) return { image: out, key: undefined };
  const old = cache.peek(slot);
  const reuse = old && old.canvas.width === oc.width && old.canvas.height === oc.height ? old.canvas : null;
  const kept = copy(oc, reuse);
  if (!kept) return { image: out, key: undefined };
  const key = nextKey();
  cache.set(slot, { srcKey, sig, w, h, canvas: kept, key });
  return { image: kept, key };
}
