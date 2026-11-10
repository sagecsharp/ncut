import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, Download, Keyboard, Redo2, Settings, Undo2 } from 'lucide-react';
import { useCanRedo, useCanUndo, useEditor } from '../../store/editorStore';
import { closeProject, useSaveState } from '../../store/session';
import type { SaveStatus } from '../../store/session';
import { useUi } from '../../store/ui';
import './shell.css';

const SAVE_LABEL: Record<SaveStatus, string> = {
  saved: 'saved',
  saving: 'saving...',
  unsaved: 'unsaved changes',
  error: 'could not save',
};

const openExport = () => useUi.getState().openDialog('export');
const openShortcuts = () => useUi.getState().openDialog('shortcuts');
const openSettings = () => useUi.getState().openDialog('settings');
const undo = () => useEditor.getState().undo();
const redo = () => useEditor.getState().redo();
const back = () => {
  void closeProject();
};

function SaveIndicator() {
  const saveState = useSaveState((s) => s.state);
  return (
    <span
      className={`shell-saved${saveState === 'error' ? ' is-error' : ''}`}
      role="status"
      title="projects are stored in this browser and saved automatically"
    >
      {SAVE_LABEL[saveState]}
    </span>
  );
}

function ProjectName() {
  const name = useEditor((s) => s.project?.name ?? '');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!editing) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next && next !== name) useEditor.getState().updateProject({ name: next });
  };

  if (!editing) {
    return (
      <button
        className="shell-name"
        title="rename project"
        onClick={() => {
          cancelled.current = false;
          setDraft(name);
          setEditing(true);
        }}
      >
        {name}
      </button>
    );
  }
  return (
    <input
      ref={inputRef}
      className="input shell-name-input"
      value={draft}
      maxLength={80}
      spellCheck={false}
      title="project name. enter to save, escape to cancel"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          e.stopPropagation();
          cancelled.current = true;
          setEditing(false);
        }
      }}
    />
  );
}

export function Header() {
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const hasClips = useEditor((s) => (s.project?.clips.length ?? 0) > 0);

  return (
    <header className="shell-header">
      <div className="shell-header-left">
        <button className="icon-btn" onClick={back} title="back to projects" aria-label="back to projects">
          <ArrowLeft size={16} />
        </button>
        <span className="shell-mark" aria-hidden="true">
          ncut
        </span>
        <ProjectName />
        <SaveIndicator />
      </div>
      <div className="shell-header-right">
        <button className="icon-btn" onClick={undo} disabled={!canUndo} title="undo (ctrl+z)" aria-label="undo">
          <Undo2 size={16} />
        </button>
        <button className="icon-btn" onClick={redo} disabled={!canRedo} title="redo (ctrl+shift+z)" aria-label="redo">
          <Redo2 size={16} />
        </button>
        <span className="shell-sep" />
        <button className="icon-btn" onClick={openShortcuts} title="keyboard shortcuts (?)" aria-label="keyboard shortcuts">
          <Keyboard size={16} />
        </button>
        <button className="icon-btn" onClick={openSettings} title="project settings (ctrl+,)" aria-label="project settings">
          <Settings size={16} />
        </button>
        <button
          className="btn btn-primary"
          onClick={openExport}
          disabled={!hasClips}
          title={hasClips ? 'export video (ctrl+e)' : 'add a clip to export'}
        >
          <Download size={14} />
          export
        </button>
      </div>
    </header>
  );
}
