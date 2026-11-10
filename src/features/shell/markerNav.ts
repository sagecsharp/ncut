/** previous / next marker lookup for the playhead. markers are sorted by time. */
import type { Marker } from '../../types';

const EPS = 1e-3;

export function prevMarkerTime(markers: readonly Marker[] | undefined, t: number): number | null {
  if (!markers) return null;
  for (let i = markers.length - 1; i >= 0; i--) {
    if (markers[i]!.time < t - EPS) return markers[i]!.time;
  }
  return null;
}

export function nextMarkerTime(markers: readonly Marker[] | undefined, t: number): number | null {
  if (!markers) return null;
  for (const m of markers) {
    if (m.time > t + EPS) return m.time;
  }
  return null;
}
