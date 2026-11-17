/** dev page hooks for the loudness meter and the measure (main.tsx puts it on window.ncut) */
export const loudnessDebug = {
  taps: 0,
  reads: 0,
  measures: 0,
  cacheHits: 0,
  samples: async (l: Float32Array, r: Float32Array, rate: number) => (await import('../../lib/loudness')).measureSamples(l, r, rate),
  mix: async (start?: number, end?: number, rate?: number) => (await import('./measureMix')).measureOpen(start, end, rate),
};
