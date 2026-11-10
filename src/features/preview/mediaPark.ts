/**
 * a small parking lot for media elements, keyed by url (pure bookkeeping, no dom, so it is tested).
 * an element that leaves the preview's window is parked instead of unloaded; the next clip of the same file takes it
 * and skips the demux + decoder start. the lot never touches the items: it only tells the caller which ones to destroy.
 */

/** most parked elements in total */
export const PARK_MAX_TOTAL = 6;
/** most parked elements of one url */
export const PARK_MAX_PER_URL = 2;

interface Slot<T> {
  url: string;
  item: T;
}

export class ParkingLot<T> {
  /** oldest first */
  private slots: Slot<T>[] = [];

  constructor(
    private readonly maxTotal = PARK_MAX_TOTAL,
    private readonly maxPerUrl = PARK_MAX_PER_URL,
  ) {}

  get size(): number {
    return this.slots.length;
  }

  countFor(url: string): number {
    let n = 0;
    for (const s of this.slots) if (s.url === url) n++;
    return n;
  }

  /** park an item. returns the items that no longer fit (the oldest ones): the caller destroys them */
  park(url: string, item: T): T[] {
    const out: T[] = [];
    this.slots.push({ url, item });
    while (this.countFor(url) > this.maxPerUrl) {
      const i = this.slots.findIndex((s) => s.url === url);
      out.push(this.slots.splice(i, 1)[0]!.item);
    }
    while (this.slots.length > this.maxTotal) out.push(this.slots.shift()!.item);
    return out;
  }

  /** the most recently parked item of that url, removed from the lot (undefined = none) */
  take(url: string): T | undefined {
    for (let i = this.slots.length - 1; i >= 0; i--) {
      if (this.slots[i]!.url === url) return this.slots.splice(i, 1)[0]!.item;
    }
    return undefined;
  }

  /** remove every item of that url (its blob url was revoked or changed) */
  evictUrl(url: string): T[] {
    return this.evictWhere((u) => u === url);
  }

  /** remove every item whose url the predicate selects */
  evictWhere(pred: (url: string) => boolean): T[] {
    const out: T[] = [];
    this.slots = this.slots.filter((s) => {
      if (!pred(s.url)) return true;
      out.push(s.item);
      return false;
    });
    return out;
  }

  /** remove everything (project closed, engine disposed) */
  clear(): T[] {
    const out = this.slots.map((s) => s.item);
    this.slots = [];
    return out;
  }
}
