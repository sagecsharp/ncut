import { create } from 'zustand';
import { NO_LOUDNESS, cleanLoudness } from './loudnessTypes';
import type { ExportLoudness } from './loudnessTypes';
import { EXPORT_SETTINGS_KEY, loadExportSettings, withLoudness } from './settings';

/** the loudness choice of the export dialog, saved per browser next to the other export settings */
export const useLoudnessPref = create<{ loudness: ExportLoudness }>(() => ({ loudness: loadExportSettings().loudness ?? NO_LOUDNESS }));

export function setLoudnessPref(l: ExportLoudness): void {
  const clean = cleanLoudness(l);
  useLoudnessPref.setState({ loudness: clean });
  try {
    localStorage.setItem(EXPORT_SETTINGS_KEY, JSON.stringify(withLoudness(loadExportSettings(), clean)));
  } catch {
    /* storage can be blocked */
  }
}

/** the rate the mix is measured at: the rate the export saves (delivery), else 48000. read at each call */
export function measureRate(): number {
  return loadExportSettings().delivery?.sampleRate === 44100 ? 44100 : 48000;
}
