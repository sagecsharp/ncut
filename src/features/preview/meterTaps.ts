/** meters ask for taps by key (a track id, or OUTPUT_TAP); the preview engine makes them. no react, no dom */
export const OUTPUT_TAP = 'output';
export const METER_WINDOW = 2048;
export interface TapLevels { peakL: number; peakR: number; rmsL: number; rmsR: number }
export interface MeterSource {
  openTap(key: string): void;
  closeTap(key: string): void;
  /** false when the tap is not built yet */
  readTap(key: string, out: TapLevels): boolean;
  /** the node after the output level and its context, for the loudness strip. null until the sound starts */
  audioOut?(): { ctx: BaseAudioContext; node: AudioNode } | null;
}

let current: MeterSource | null = null;
const held = new Map<string, number>();

/** replays the held keys into s */
export function setMeterSource(s: MeterSource): void {
  current = s;
  for (const k of held.keys()) s.openTap(k);
}

/** only when s is the current one */
export function clearMeterSource(s: MeterSource): void {
  if (current === s) current = null;
}

/** counted: opened on the first hold, closed on the last release. a release twice is safe */
export function holdTap(key: string): () => void {
  const n = held.get(key) ?? 0;
  held.set(key, n + 1);
  if (n === 0) current?.openTap(key);
  let done = false;
  return () => {
    if (done) return;
    done = true;
    const left = (held.get(key) ?? 1) - 1;
    if (left > 0) {
      held.set(key, left);
      return;
    }
    held.delete(key);
    current?.closeTap(key);
  };
}

export function readTap(key: string, out: TapLevels): boolean {
  return current ? current.readTap(key, out) : false;
}

export function audioOut(): { ctx: BaseAudioContext; node: AudioNode } | null { return current?.audioOut?.() ?? null; }

export function heldTaps(): string[] {
  return [...held.keys()];
}

/** peak (largest |sample|) and rms of one block */
export function blockLevels(data: Float32Array): { peak: number; rms: number } {
  let peak = 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = data[i]!;
    const a = v < 0 ? -v : v;
    if (a > peak) peak = a;
    sum += v * v;
  }
  return { peak, rms: data.length ? Math.sqrt(sum / data.length) : 0 };
}
