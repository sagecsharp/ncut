import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource/kode-mono/400.css';
import '@fontsource/kode-mono/500.css';
import '@fontsource/kode-mono/700.css';
import './styles/theme.css';
import './styles/base.css';
import './components/ui/ui.css';
import { App } from './App';
import { EFFECTS } from './engine/effects/registry';
import { checkEffects, renderEffects } from './engine/effects/runner';
import { drawTestPattern } from './engine/effects/testPattern';
import { TRANSITIONS } from './engine/transitions/registry';
import { checkTransitions, renderTransition } from './engine/transitions/runner';
import { initAppearance } from './lib/appearance';
import { importFiles } from './media/importer';
import { useEditor } from './store/editorStore';
import { usePlayback } from './store/playback';
import * as session from './store/session';
import { useUi } from './store/ui';

initAppearance();
// the canvas (preview + export) can only draw a web font once it is loaded, so fetch both weights up front
if (document.fonts) {
  void document.fonts.load('400 16px "Kode Mono"');
  void document.fonts.load('700 16px "Kode Mono"');
}
session.startAutosave();

// handy for poking at the app from the devtools console (dev builds only)
if (import.meta.env.DEV || import.meta.env.MODE === 'bench') {
  // benchmarks and pixel comparisons (src/dev/bench.ts), never in a normal build
  void import('./dev/bench').then((m) => {
    ((window as unknown as Record<string, unknown>).__ncut as Record<string, unknown>).bench = m.bench;
  });
  (window as unknown as Record<string, unknown>).__ncut = {
    useEditor,
    usePlayback,
    useUi,
    session,
    importFiles,
    fx: { EFFECTS, checkEffects, renderEffects, drawTestPattern, TRANSITIONS, checkTransitions, renderTransition },
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
