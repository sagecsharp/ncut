import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/theme.css';
import './styles/base.css';
import './components/ui/ui.css';
import { App } from './App';
import { importFiles } from './media/importer';
import { useEditor } from './store/editorStore';
import { usePlayback } from './store/playback';
import * as session from './store/session';
import { useUi } from './store/ui';

session.startAutosave();

// handy for poking at the app from the devtools console (dev builds only)
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__ncut = { useEditor, usePlayback, useUi, session, importFiles };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
