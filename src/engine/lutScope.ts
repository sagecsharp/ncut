/**
 * which lut tables a render may use. a render runs inside withLuts, the grade reads the table of a lut media
 * through lutNow. no lookup (the bench, thumbnails) = no luts.
 */
import type { LutTable } from '../lib/cube';

export type LutLookup = (media: string) => LutTable | null;

let current: LutLookup | null = null;

export function lutNow(media: string): LutTable | null {
  return current ? current(media) : null;
}

export function withLuts<T>(lookup: LutLookup | null | undefined, fn: () => T): T {
  const before = current;
  current = lookup ?? null;
  try {
    return fn();
  } finally {
    current = before;
  }
}
