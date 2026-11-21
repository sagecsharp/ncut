import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { ChevronRight, Copy, Download, FolderInput, FolderOpen, FolderPlus, Pencil, Plus, Search, Settings, Trash2 } from 'lucide-react';
import type { ProjectSummary } from '../../types';
import { Dialog } from '../../components/ui/Dialog';
import { CANVAS_PRESETS, FPS_OPTIONS } from '../../lib/factory';
import { PROJECT_TEMPLATES, getTemplate } from '../../lib/templates';
import { formatDuration } from '../../lib/time';
import {
  createAndOpenProject,
  deleteStoredProject,
  duplicateProject,
  exportProjectFile,
  importProjectFile,
  openProjectById,
  renameStoredProject,
} from '../../store/session';
import { useUi } from '../../store/ui';
import { AppSettings } from '../shell/AppSettings';
import { listProjects } from '../../storage/db';
import { loadPoster } from '../../storage/posters';
import { PROJECT_FILE_EXT } from '../../storage/projectFile';
import { FolderTile, MoveList, PROJECT_DRAG_MIME, useProjectDrop } from './FolderTile';
import {
  addFolder,
  folderCounts,
  folderOf,
  getFolders,
  moveProjects,
  newFolderId,
  pruneFolders,
  removeFolder,
  renameFolder,
  sortedFolders,
  updateFolders,
  useFolders,
} from './folders';
import './projects.css';

type SortMode = 'recent' | 'name';

const SEARCH_THRESHOLD = 6;
const MAX_PREVIEW_W = 200;
const MAX_PREVIEW_H = 120;
const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'file', 'submit', 'reset']);

function fail(e: unknown, fallback: string): void {
  console.error(e);
  useUi.getState().toast(e instanceof Error && e.message ? e.message : fallback, 'error');
}

function relativeTime(then: number, now: number): string {
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 45) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  if (d < 30) return d === 1 ? 'yesterday' : `${d} days ago`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo ago`;
  return `${Math.round(mo / 12)} y ago`;
}

function BrandMark() {
  return (
    <svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="6" fill="var(--surface-3)" />
      <rect x="5" y="8" width="14" height="6" rx="1.5" fill="var(--accent)" />
      <rect x="11" y="18" width="16" height="6" rx="1.5" fill="var(--text-faint)" />
      <rect x="20.5" y="5" width="2" height="22" fill="var(--playhead)" />
    </svg>
  );
}

interface CardProps {
  project: ProjectSummary;
  /** the folder it is in, shown while searching (the search looks in every folder) */
  folderName: string | null;
  now: number;
  busy: boolean;
  renaming: boolean;
  onOpen(id: string): void;
  onStartRename(id: string): void;
  onCommitRename(id: string, name: string): void;
  onCancelRename(): void;
  onDuplicate(id: string): void;
  onExportFile(id: string): void;
  onDelete(id: string): void;
  onMove(id: string): void;
}

const ProjectCard = memo(function ProjectCard({
  project,
  folderName,
  now,
  busy,
  renaming,
  onOpen,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDuplicate,
  onExportFile,
  onDelete,
  onMove,
}: CardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    if (renaming) {
      doneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const scale = Math.min(MAX_PREVIEW_W / project.width, MAX_PREVIEW_H / project.height);
  const frameStyle = { width: Math.round(project.width * scale), height: Math.round(project.height * scale) };
  // the poster is taken when the project is closed, which also bumps updatedAt
  const poster = useMemo(() => loadPoster(project.id), [project.id, project.updatedAt]);
  const id = project.id;

  const onCardKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming || e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      onStartRename(id);
    }
  };

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommitRename(id, inputRef.current?.value ?? project.name);
  };

  const act = (fn: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className={`projects-card${busy ? ' is-busy' : ''}${renaming ? ' is-renaming' : ''}`}
      data-project-id={id}
      role="button"
      tabIndex={0}
      title={`open ${project.name}`}
      aria-busy={busy}
      draggable={!renaming && !busy}
      onDragStart={(e) => {
        // a card dragged onto a folder (or onto "projects" in the path) moves there
        e.dataTransfer.setData(PROJECT_DRAG_MIME, id);
        e.dataTransfer.effectAllowed = 'move';
      }}
      onClick={() => {
        if (!renaming) onOpen(id);
      }}
      onKeyDown={onCardKey}
    >
      <div className="projects-preview">
        <div className="projects-frame" style={frameStyle}>
          {poster ? <img className="projects-poster" src={poster} alt="" draggable={false} /> : null}
        </div>
        {busy ? <span className="projects-busy">opening...</span> : null}
      </div>
      <div className="projects-info">
        {renaming ? (
          <input
            ref={inputRef}
            className="input input-sm projects-rename"
            defaultValue={project.name}
            title="project name. enter to save, escape to cancel"
            aria-label="project name"
            maxLength={120}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commit();
              else if (e.key === 'Escape') {
                doneRef.current = true;
                onCancelRename();
              }
            }}
            onBlur={commit}
          />
        ) : (
          <div className="projects-card-name" title={project.name}>
            {project.name}
          </div>
        )}
        {folderName ? (
          <div className="projects-in-folder" title={`in the folder ${folderName}`}>
            in {folderName}
          </div>
        ) : null}
        <div className="projects-meta mono">
          {project.width}x{project.height} / {project.fps} fps / {formatDuration(project.duration)} / {project.clipCount}{' '}
          {project.clipCount === 1 ? 'clip' : 'clips'}
        </div>
        <div className="projects-foot">
          <span className="projects-edited">edited {relativeTime(project.updatedAt, now)}</span>
          <div className="projects-actions">
            <button
              className="icon-btn icon-btn-sm"
              title="rename"
              aria-label="rename"
              onClick={act(() => onStartRename(id))}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Pencil size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="move to a folder (or drag the card onto one)"
              aria-label="move to a folder"
              onClick={act(() => onMove(id))}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <FolderInput size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="duplicate"
              aria-label="duplicate"
              onClick={act(() => onDuplicate(id))}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Copy size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="save as a file (project + media) for backup or another computer"
              aria-label="save as a file"
              onClick={act(() => onExportFile(id))}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Download size={14} />
            </button>
            <button
              className="icon-btn icon-btn-sm"
              title="delete"
              aria-label="delete"
              onClick={act(() => onDelete(id))}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <Trash2 size={14} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

export function ProjectsScreen() {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortMode>('recent');
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  const [newName, setNewName] = useState('untitled project');
  const [presetId, setPresetId] = useState(CANVAS_PRESETS[0]!.id);
  const [templateId, setTemplateId] = useState('');
  const [fps, setFps] = useState(30);
  const [transparent, setTransparent] = useState(false);
  const [creating, setCreating] = useState(false);
  // folders: the open one (null = the top level), the one being renamed or deleted, the project being moved
  const folderState = useFolders();
  const [folderId, setFolderId] = useState<string | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<string | null>(null);
  const [deleteFolderId, setDeleteFolderId] = useState<string | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const openFolder = folderId !== null ? (folderState.folders.find((f) => f.id === folderId) ?? null) : null;
  // a folder that went away (deleted here) takes the view back to the top
  useEffect(() => {
    if (folderId !== null && !openFolder) setFolderId(null);
  }, [folderId, openFolder]);
  const folderIdRef = useRef(folderId);
  folderIdRef.current = folderId;

  const mounted = useRef(true);
  const openingRef = useRef<string | null>(null);
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  const refresh = useCallback(async () => {
    try {
      const list = await listProjects();
      // a deleted project leaves no link behind in its folder
      updateFolders((s) => pruneFolders(s, list.map((x) => x.id)));
      if (!mounted.current) return;
      setProjects(list);
      setNow(Date.now());
    } catch (e) {
      fail(e, 'could not load projects');
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
    };
  }, [refresh]);

  // the agent (mcp) can delete or add stored projects while this screen is up
  const projectsVersion = useUi((s) => s.projectsVersion);
  const seenVersion = useRef(projectsVersion);
  useEffect(() => {
    if (seenVersion.current === projectsVersion) return;
    seenVersion.current = projectsVersion;
    void refresh();
  }, [projectsVersion, refresh]);

  const [settingsOpen, setSettingsOpen] = useState(false);

  const openNew = useCallback(() => {
    setNewName('untitled project');
    setNewOpen(true);
  }, []);

  // the dialog focuses itself on open (child effect), so focus the name input after it
  useEffect(() => {
    if (!newOpen) return;
    const el = document.getElementById('projects-new-name') as HTMLInputElement | null;
    el?.focus();
    el?.select();
  }, [newOpen]);

  // "n" opens the new project dialog when nothing is being typed into
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'n' && e.key !== 'N') return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (document.querySelector('.dialog-backdrop')) return;
      e.preventDefault();
      openNew();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openNew]);

  // ctrl+, opens the settings, like in the editor: not while typing and not under another dialog
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== 'Comma' || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
      if (e.defaultPrevented || e.isComposing) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || t.tagName === 'TEXTAREA')) return;
      if (t && t.tagName === 'INPUT' && !NON_TEXT_INPUTS.has((t as HTMLInputElement).type)) return;
      if (document.querySelector('.dialog-backdrop')) return;
      e.preventDefault();
      setSettingsOpen(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onOpen = useCallback(
    async (id: string) => {
      if (openingRef.current) return;
      openingRef.current = id;
      setOpeningId(id);
      try {
        const ok = await openProjectById(id);
        if (!ok) {
          useUi.getState().toast('project not found', 'error');
          await refresh();
        }
      } catch (e) {
        fail(e, 'could not open the project');
      } finally {
        openingRef.current = null;
        if (mounted.current) setOpeningId(null);
      }
    },
    [refresh],
  );

  const onStartRename = useCallback((id: string) => setRenamingId(id), []);
  const onCancelRename = useCallback(() => setRenamingId(null), []);
  const onCommitRename = useCallback(
    async (id: string, name: string) => {
      setRenamingId(null);
      const trimmed = name.trim();
      const current = projectsRef.current.find((p) => p.id === id);
      if (!trimmed || !current || trimmed === current.name) return;
      try {
        await renameStoredProject(id, trimmed);
      } catch (e) {
        fail(e, 'could not rename the project');
      }
      await refresh();
    },
    [refresh],
  );

  const onDuplicate = useCallback(
    async (id: string) => {
      try {
        const newId = await duplicateProject(id);
        if (!newId) useUi.getState().toast('project not found', 'error');
        else {
          // the copy sits next to the original
          const fid = folderOf(getFolders(), id);
          if (fid) updateFolders((s) => moveProjects(s, [newId], fid));
          useUi.getState().toast('project duplicated', 'success');
        }
      } catch (e) {
        fail(e, 'could not duplicate the project');
      }
      await refresh();
    },
    [refresh],
  );

  const onExportFile = useCallback(async (id: string) => {
    try {
      const out = await exportProjectFile(id);
      if (!out) {
        useUi.getState().toast('project not found', 'error');
        return;
      }
      const url = URL.createObjectURL(out.blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = out.fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      useUi.getState().toast('saved ' + out.fileName, 'success');
    } catch (e) {
      fail(e, 'could not save the project file');
    }
  }, []);

  const fileInput = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const onImportFiles = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return;
      setImporting(true);
      let added = 0;
      for (const file of Array.from(files)) {
        try {
          const newId = await importProjectFile(file);
          // an opened file lands in the folder that is open
          const fid = folderIdRef.current;
          if (fid) updateFolders((s) => moveProjects(s, [newId], fid));
          added++;
        } catch (e) {
          fail(e, 'could not open ' + file.name);
        }
      }
      if (fileInput.current) fileInput.current.value = '';
      if (!mounted.current) return;
      setImporting(false);
      if (added > 0) useUi.getState().toast(added === 1 ? 'project added' : added + ' projects added', 'success');
      await refresh();
    },
    [refresh],
  );

  const onAskDelete = useCallback((id: string) => setDeleteId(id), []);

  const confirmDelete = async () => {
    if (!deleteId || deleting) return;
    setDeleting(true);
    try {
      await deleteStoredProject(deleteId);
    } catch (e) {
      fail(e, 'could not delete the project');
    }
    if (!mounted.current) return;
    setDeleting(false);
    setDeleteId(null);
    await refresh();
  };

  const submitNew = async () => {
    if (creating) return;
    const preset = CANVAS_PRESETS.find((p) => p.id === presetId) ?? CANVAS_PRESETS[0]!;
    setCreating(true);
    const into = folderId;
    try {
      const made = await createAndOpenProject(newName.trim() || 'untitled project', preset, fps, templateId || null, transparent);
      // a project made inside a folder belongs to it
      if (into) updateFolders((s) => moveProjects(s, [made.id], into));
    } catch (e) {
      fail(e, 'could not create the project');
    }
    if (!mounted.current) return;
    setCreating(false);
    setNewOpen(false);
    void refresh();
  };

  const searching = query.trim() !== '';
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    // a search looks in every folder; else the open folder, or (at the top) the projects in no folder
    const list = q
      ? projects.filter((p) => p.name.toLowerCase().includes(q))
      : projects.filter((p) => folderOf(folderState, p.id) === folderId);
    if (sort === 'name') list.sort((a, b) => a.name.localeCompare(b.name));
    else list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }, [projects, query, sort, folderState, folderId]);

  const folderList = useMemo(() => sortedFolders(folderState), [folderState]);
  const counts = useMemo(() => folderCounts(folderState, projects.map((p) => p.id)), [folderState, projects]);
  const folderNameOf = (pid: string): string | null => {
    const fid = folderOf(folderState, pid);
    return fid ? (folderState.folders.find((f) => f.id === fid)?.name ?? null) : null;
  };

  /** a new folder at the top level, its name ready to type over. answers its id */
  const onNewFolder = useCallback((): string => {
    const id = newFolderId();
    updateFolders((s) => addFolder(s, id, 'new folder', Date.now()));
    setFolderId(null);
    setQuery('');
    setRenamingFolder(id);
    return id;
  }, []);
  const onCommitFolderRename = useCallback((id: string, name: string) => {
    setRenamingFolder(null);
    updateFolders((s) => renameFolder(s, id, name));
  }, []);
  const onCancelFolderRename = useCallback(() => setRenamingFolder(null), []);
  const onDropInFolder = useCallback((pid: string, fid: string | null) => {
    updateFolders((s) => moveProjects(s, [pid], fid));
  }, []);
  const onAskMove = useCallback((id: string) => setMoveId(id), []);
  const confirmDeleteFolder = () => {
    if (!deleteFolderId) return;
    updateFolders((s) => removeFolder(s, deleteFolderId));
    setDeleteFolderId(null);
  };
  const moveTarget = moveId ? projects.find((p) => p.id === moveId) : undefined;
  const deleteFolderTarget = deleteFolderId ? folderState.folders.find((f) => f.id === deleteFolderId) : undefined;
  // "projects" in the path takes a dropped card out of the open folder
  const topDrop = useProjectDrop((pid) => onDropInFolder(pid, null));
  const showFolders = folderId === null && !searching;

  const deleteTarget = deleteId ? projects.find((p) => p.id === deleteId) : undefined;
  const showSearch = projects.length >= SEARCH_THRESHOLD;

  return (
    <div className="projects">
      <header className="projects-top">
        <div className="projects-brand">
          <BrandMark />
          <span className="projects-name">ncut</span>
        </div>
        <p className="projects-tagline">local-only video editor. no accounts, no watermark.</p>
        <button className="icon-btn" onClick={() => setSettingsOpen(true)} title="settings (ctrl+,)" aria-label="settings">
          <Settings size={16} />
        </button>
        <input
          ref={fileInput}
          type="file"
          accept={PROJECT_FILE_EXT}
          multiple
          hidden
          onChange={(e) => void onImportFiles(e.target.files)}
        />
        <button
          className="btn"
          onClick={() => fileInput.current?.click()}
          disabled={importing}
          title="open a project file (.ncut) saved from ncut"
        >
          <FolderOpen size={16} />
          {importing ? 'opening...' : 'open file'}
        </button>
        <button className="btn btn-primary" onClick={openNew} title="new project (n)">
          <Plus size={16} />
          new project
        </button>
      </header>

      <Dialog open={settingsOpen} title="settings" onClose={() => setSettingsOpen(false)} width={420}>
        <AppSettings />
      </Dialog>

      <main className="projects-main">
        {!loaded ? (
          <div className="projects-empty">loading...</div>
        ) : projects.length === 0 && folderState.folders.length === 0 ? (
          <div className="projects-empty">
            <div className="projects-empty-title">no projects yet</div>
            <div>everything you make stays on this machine.</div>
            <button className="btn btn-primary" onClick={openNew} title="new project (n)">
              <Plus size={16} />
              new project
            </button>
          </div>
        ) : (
          <>
            <div className="projects-toolbar">
              <div className="projects-heading">
                {openFolder && !searching ? (
                  <nav className="projects-path" aria-label="folder path">
                    <button
                      type="button"
                      className={`btn btn-sm btn-ghost projects-path-top${topDrop.over ? ' is-drop' : ''}`}
                      onClick={() => setFolderId(null)}
                      title="back to all folders. drop a project here to take it out of this folder"
                      {...topDrop.handlers}
                    >
                      projects
                    </button>
                    <ChevronRight size={14} aria-hidden="true" />
                    <span className="projects-path-here" title={openFolder.name}>
                      {openFolder.name} ({visible.length})
                    </span>
                  </nav>
                ) : (
                  <>
                    projects ({searching ? `${visible.length} of ${projects.length}` : projects.length})
                  </>
                )}
              </div>
              {folderId === null ? (
                <button className="btn btn-sm" onClick={() => onNewFolder()} title="a new folder to sort projects into">
                  <FolderPlus size={14} />
                  new folder
                </button>
              ) : null}
              {showSearch ? (
                <div className="field-row">
                  <Search size={14} />
                  <input
                    className="input projects-search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="search by name"
                    title="filter projects by name"
                    aria-label="search projects"
                  />
                </div>
              ) : null}
              {projects.length > 1 ? (
                <select
                  className="select"
                  value={sort}
                  onChange={(e) => setSort(e.target.value as SortMode)}
                  title="sort projects"
                  aria-label="sort projects"
                >
                  <option value="recent">recent</option>
                  <option value="name">name</option>
                </select>
              ) : null}
            </div>
            {visible.length === 0 && (searching || !showFolders || folderList.length === 0) ? (
              <div className="projects-empty">
                {searching
                  ? `no projects match "${query.trim()}"`
                  : openFolder
                    ? 'this folder is empty. drag a project onto it, or use the move button on a project, or make a new one here'
                    : 'every project is in a folder'}
              </div>
            ) : (
              <div className="projects-grid">
                {showFolders
                  ? folderList.map((f) => (
                      <FolderTile
                        key={f.id}
                        folder={f}
                        count={counts.get(f.id) ?? 0}
                        renaming={renamingFolder === f.id}
                        onOpen={setFolderId}
                        onStartRename={setRenamingFolder}
                        onCommitRename={onCommitFolderRename}
                        onCancelRename={onCancelFolderRename}
                        onDelete={setDeleteFolderId}
                        onDropProject={onDropInFolder}
                      />
                    ))
                  : null}
                {visible.map((p) => (
                  <ProjectCard
                    key={p.id}
                    project={p}
                    folderName={searching ? folderNameOf(p.id) : null}
                    now={now}
                    busy={openingId === p.id}
                    renaming={renamingId === p.id}
                    onOpen={onOpen}
                    onStartRename={onStartRename}
                    onCommitRename={onCommitRename}
                    onCancelRename={onCancelRename}
                    onDuplicate={onDuplicate}
                    onExportFile={onExportFile}
                    onDelete={onAskDelete}
                    onMove={onAskMove}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </main>

      <Dialog
        open={newOpen}
        title="new project"
        onClose={() => setNewOpen(false)}
        dismissable={!creating}
        footer={
          <>
            <button className="btn" onClick={() => setNewOpen(false)} disabled={creating} title="cancel">
              cancel
            </button>
            <button className="btn btn-primary" onClick={() => void submitNew()} disabled={creating} title="create the project">
              {creating ? 'creating...' : 'create'}
            </button>
          </>
        }
      >
        <div className="field">
          <label className="field-label" htmlFor="projects-new-name">
            name
          </label>
          <input
            id="projects-new-name"
            className="input"
            value={newName}
            maxLength={120}
            title="project name"
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submitNew();
            }}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-preset">
            canvas
          </label>
          <select
            id="projects-new-preset"
            className="select"
            value={presetId}
            title="canvas size"
            onChange={(e) => setPresetId(e.target.value)}
          >
            {CANVAS_PRESETS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-background">
            background
          </label>
          <select
            id="projects-new-background"
            className="select"
            value={transparent ? 'transparent' : 'color'}
            title="a black background, or a transparent canvas (see-through where nothing is drawn, for a webm or png with alpha). you can change it later in the project panel"
            onChange={(e) => setTransparent(e.target.value === 'transparent')}
          >
            <option value="color">black</option>
            <option value="transparent">transparent</option>
          </select>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-template">
            start with
          </label>
          <select
            id="projects-new-template"
            className="select"
            value={templateId}
            title="start empty or with a ready-made timeline you can take apart"
            onChange={(e) => setTemplateId(e.target.value)}
          >
            <option value="">an empty timeline</option>
            {PROJECT_TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          {templateId ? <p className="projects-template-hint">{getTemplate(templateId)?.description}</p> : null}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="projects-new-fps">
            frame rate
          </label>
          <select
            id="projects-new-fps"
            className="select"
            value={fps}
            title="frame rate"
            onChange={(e) => setFps(Number(e.target.value))}
          >
            {FPS_OPTIONS.map((f) => (
              <option key={f} value={f}>
                {f} fps
              </option>
            ))}
          </select>
        </div>
      </Dialog>

      <Dialog open={moveTarget !== undefined} title="move to a folder" onClose={() => setMoveId(null)} width={360}>
        <p className="projects-move-what">
          <span className="projects-confirm-name">{moveTarget?.name}</span>
        </p>
        <MoveList
          folders={folderList}
          current={moveTarget ? folderOf(folderState, moveTarget.id) : null}
          onPick={(fid) => {
            if (moveTarget) onDropInFolder(moveTarget.id, fid);
            setMoveId(null);
          }}
          onNewFolder={() => {
            const pid = moveTarget?.id;
            const fid = onNewFolder();
            if (pid) onDropInFolder(pid, fid);
            setMoveId(null);
          }}
        />
      </Dialog>

      <Dialog
        open={deleteFolderTarget !== undefined}
        title="delete folder"
        onClose={() => setDeleteFolderId(null)}
        width={400}
        footer={
          <>
            <button className="btn" onClick={() => setDeleteFolderId(null)} title="keep the folder">
              cancel
            </button>
            <button className="btn btn-danger" onClick={confirmDeleteFolder} title="delete the folder, keep its projects">
              delete folder
            </button>
          </>
        }
      >
        <p>
          delete the folder <span className="projects-confirm-name">{deleteFolderTarget?.name}</span>?{' '}
          {(counts.get(deleteFolderId ?? '') ?? 0) > 0
            ? `its ${counts.get(deleteFolderId ?? '')} ${counts.get(deleteFolderId ?? '') === 1 ? 'project stays' : 'projects stay'}, out of any folder. no project is deleted.`
            : 'it is empty.'}
        </p>
      </Dialog>

      <Dialog
        open={deleteId !== null}
        title="delete project"
        onClose={() => setDeleteId(null)}
        dismissable={!deleting}
        width={400}
        footer={
          <>
            <button className="btn" onClick={() => setDeleteId(null)} disabled={deleting} title="cancel">
              cancel
            </button>
            <button className="btn btn-danger" onClick={() => void confirmDelete()} disabled={deleting} title="delete forever">
              {deleting ? 'deleting...' : 'delete'}
            </button>
          </>
        }
      >
        <p>
          delete <span className="projects-confirm-name">{deleteTarget?.name ?? 'this project'}</span> and its media? this
          cannot be undone.
        </p>
      </Dialog>
    </div>
  );
}
