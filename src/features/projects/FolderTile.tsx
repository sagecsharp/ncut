import { memo, useEffect, useRef, useState } from 'react';
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Folder, FolderPlus, Pencil, Trash2 } from 'lucide-react';
import { FOLDER_NAME_MAX, type ProjectFolder } from './folders';

/** what a dragged project card carries: its id, under its own type (nothing else on the page reads it) */
export const PROJECT_DRAG_MIME = 'application/x-ncut-project';

export function isProjectDrag(e: ReactDragEvent): boolean {
  return e.dataTransfer.types.includes(PROJECT_DRAG_MIME);
}

/** the props of anything a project card can be dropped on: a folder, or "projects" (out of every folder) */
export function useProjectDrop(onDropProject: (projectId: string) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: ReactDragEvent) => {
        if (!isProjectDrag(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (!over) setOver(true);
      },
      onDragLeave: (e: ReactDragEvent) => {
        if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
        setOver(false);
      },
      onDrop: (e: ReactDragEvent) => {
        setOver(false);
        if (!isProjectDrag(e)) return;
        e.preventDefault();
        const id = e.dataTransfer.getData(PROJECT_DRAG_MIME);
        if (id) onDropProject(id);
      },
    },
  };
}

interface TileProps {
  folder: ProjectFolder;
  count: number;
  renaming: boolean;
  onOpen(id: string): void;
  onStartRename(id: string): void;
  onCommitRename(id: string, name: string): void;
  onCancelRename(): void;
  onDelete(id: string): void;
  onDropProject(projectId: string, folderId: string): void;
}

/** a folder on the projects screen: a click opens it, a project card dropped on it moves in */
export const FolderTile = memo(function FolderTile({ folder, count, renaming, onOpen, onStartRename, onCommitRename, onCancelRename, onDelete, onDropProject }: TileProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const doneRef = useRef(false);
  const id = folder.id;
  const { over, handlers } = useProjectDrop((pid) => onDropProject(pid, id));

  useEffect(() => {
    if (renaming) {
      doneRef.current = false;
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [renaming]);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommitRename(id, inputRef.current?.value ?? folder.name);
  };

  const onKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (renaming || e.target !== e.currentTarget) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      onOpen(id);
    } else if (e.key === 'F2') {
      e.preventDefault();
      onStartRename(id);
    }
  };

  const act = (fn: () => void) => (e: { stopPropagation(): void }) => {
    e.stopPropagation();
    fn();
  };

  return (
    <div
      className={`projects-folder${over ? ' is-drop' : ''}${renaming ? ' is-renaming' : ''}`}
      data-folder-id={id}
      role="button"
      tabIndex={0}
      title={`open the folder ${folder.name}. drop a project here to move it in`}
      onClick={() => {
        if (!renaming) onOpen(id);
      }}
      onKeyDown={onKey}
      {...handlers}
    >
      <div className="projects-folder-art">
        <Folder size={56} strokeWidth={1.25} className="projects-folder-icon" aria-hidden="true" />
      </div>
      <div className="projects-folder-info">
        {renaming ? (
          <input
            ref={inputRef}
            className="input input-sm projects-rename"
            defaultValue={folder.name}
            maxLength={FOLDER_NAME_MAX}
            title="folder name. enter to save, escape to cancel"
            aria-label="folder name"
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
          <div className="projects-card-name" title={folder.name}>
            {folder.name}
          </div>
        )}
        <div className="projects-foot">
          <span className="projects-meta">{count === 1 ? '1 project' : `${count} projects`}</span>
          <div className="projects-actions">
        <button className="icon-btn icon-btn-sm" title="rename the folder" aria-label="rename the folder" onClick={act(() => onStartRename(id))} onKeyDown={(e) => e.stopPropagation()}>
          <Pencil size={14} />
        </button>
        <button
          className="icon-btn icon-btn-sm"
          title="delete the folder (its projects stay)"
          aria-label="delete the folder"
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

interface MoveListProps {
  folders: ProjectFolder[];
  current: string | null;
  onPick(folderId: string | null): void;
  onNewFolder(): void;
}

/** the choices of "move to folder": every folder, no folder, or a new one */
export function MoveList({ folders, current, onPick, onNewFolder }: MoveListProps) {
  return (
    <div className="projects-move-list" role="list">
      <button type="button" className={`btn projects-move-item${current === null ? ' is-current' : ''}`} disabled={current === null} onClick={() => onPick(null)} title="out of every folder">
        no folder
      </button>
      {folders.map((f) => (
        <button
          key={f.id}
          type="button"
          className={`btn projects-move-item${current === f.id ? ' is-current' : ''}`}
          disabled={current === f.id}
          onClick={() => onPick(f.id)}
          title={current === f.id ? 'it is in this folder' : `move it to ${f.name}`}
        >
          <Folder size={14} aria-hidden="true" />
          <span className="projects-move-name">{f.name}</span>
        </button>
      ))}
      <button type="button" className="btn projects-move-item" onClick={onNewFolder} title="make a new folder and move it there">
        <FolderPlus size={14} aria-hidden="true" />
        new folder
      </button>
    </div>
  );
}
