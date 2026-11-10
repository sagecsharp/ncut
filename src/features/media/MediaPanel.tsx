import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { Film, Image as ImageIcon, Music, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { Dialog } from '../../components/ui/Dialog';
import { ACCEPTED_TYPES, deleteAsset, importFiles, useImporting } from '../../media/importer';
import { getThumbnail } from '../../media/derived';
import { beginDrag, endDrag, isFileDrag } from '../../lib/dnd';
import { DEFAULT_TRANSFORM } from '../../types';
import type { MediaAsset, MediaKind, TextClip } from '../../types';
import { formatBytes, formatDuration } from '../../lib/time';
import { EffectsTab } from './EffectsTab';
import './media.css';

type Tab = 'media' | 'text' | 'effects';
type Filter = 'all' | MediaKind;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'video', label: 'video' },
  { id: 'audio', label: 'audio' },
  { id: 'image', label: 'image' },
];

function KindIcon({ kind, size = 12 }: { kind: MediaKind; size?: number }) {
  if (kind === 'video') return <Film size={size} />;
  if (kind === 'audio') return <Music size={size} />;
  return <ImageIcon size={size} />;
}

/* ---------- asset card ---------- */

interface AssetCardProps {
  asset: MediaAsset;
  onInsert: (id: string) => void;
  onRemove: (id: string) => void;
}

const AssetCard = memo(function AssetCard({ asset, onInsert, onRemove }: AssetCardProps) {
  const { id, kind } = asset;
  const cardRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asset.name);

  // only start loading the thumbnail once the card is close to the viewport
  useEffect(() => {
    if (kind === 'audio') return;
    const el = cardRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setNear(true);
          io.disconnect();
        }
      },
      { rootMargin: '120px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [kind]);

  useEffect(() => {
    if (!near) return;
    let alive = true;
    void getThumbnail(id).then((u) => {
      if (alive) setThumb(u);
    });
    return () => {
      alive = false;
    };
  }, [near, id]);

  const startEdit = useCallback(() => {
    setDraft(asset.name);
    setEditing(true);
  }, [asset.name]);

  const commit = useCallback(() => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== asset.name) useEditor.getState().renameAsset(id, name);
  }, [draft, asset.name, id]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editing || e.target !== e.currentTarget) return;
    if (e.key === 'F2') {
      e.preventDefault();
      startEdit();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onInsert(id);
    }
  };

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    beginDrag(e, { kind: 'asset', assetId: id });
  };

  const dims = asset.width && asset.height ? ` - ${asset.width}x${asset.height}` : '';
  const tip = `${asset.name} - ${formatBytes(asset.size)}${dims}`;

  return (
    <div
      ref={cardRef}
      className="media-card"
      draggable={!editing}
      tabIndex={0}
      title={tip}
      onDragStart={onDragStart}
      onDragEnd={endDrag}
      onDoubleClick={() => onInsert(id)}
      onKeyDown={onKeyDown}
    >
      <div className={`media-thumb is-${kind}`}>
        {thumb ? <img className="media-thumb-img" src={thumb} alt="" draggable={false} /> : <KindIcon kind={kind} size={22} />}
        <span className="media-badge media-badge-kind">
          <KindIcon kind={kind} />
        </span>
        {kind !== 'image' ? <span className="media-badge media-badge-dur mono">{formatDuration(asset.duration)}</span> : null}
        <div className="media-actions">
          <button
            className="icon-btn icon-btn-sm"
            title="add to timeline at the playhead"
            aria-label="add to timeline"
            onClick={(e) => {
              e.stopPropagation();
              onInsert(id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Plus size={14} />
          </button>
          <button
            className="icon-btn icon-btn-sm"
            title="remove from project"
            aria-label="remove"
            onClick={(e) => {
              e.stopPropagation();
              onRemove(id);
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {editing ? (
        <input
          className="input input-sm media-rename"
          value={draft}
          autoFocus
          title="asset name"
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          onDoubleClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div
          className="media-name"
          title="double click to rename (f2)"
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit();
          }}
        >
          {asset.name}
        </div>
      )}
    </div>
  );
});

/* ---------- media tab ---------- */

interface PendingRemove {
  id: string;
  name: string;
  clips: number;
}

function MediaTab() {
  const assets = useEditor((s) => s.project?.assets);
  const importing = useImporting((s) => s.count);
  const fileRef = useRef<HTMLInputElement>(null);
  const depth = useRef(0);
  const [dragging, setDragging] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [pending, setPending] = useState<PendingRemove | null>(null);

  const onInsert = useCallback((id: string) => {
    useEditor.getState().insertAsset(id, { start: usePlayback.getState().time });
  }, []);

  const onRemove = useCallback((id: string) => {
    const project = useEditor.getState().project;
    if (!project) return;
    const asset = project.assets.find((a) => a.id === id);
    if (!asset) return;
    const clips = project.clips.filter((c) => 'assetId' in c && c.assetId === id).length;
    if (clips > 0) setPending({ id, name: asset.name, clips });
    else void deleteAsset(id);
  }, []);

  const confirmRemove = useCallback(() => {
    if (pending) void deleteAsset(pending.id);
    setPending(null);
  }, [pending]);
  const cancelRemove = useCallback(() => setPending(null), []);

  const visible = useMemo(() => {
    if (!assets) return [];
    const q = query.trim().toLowerCase();
    return assets.filter((a) => (filter === 'all' || a.kind === filter) && (!q || a.name.toLowerCase().includes(q)));
  }, [assets, filter, query]);

  const onPick = () => fileRef.current?.click();
  const onFiles = (files: FileList | null) => {
    if (files && files.length > 0) void importFiles(Array.from(files));
    if (fileRef.current) fileRef.current.value = '';
  };

  const onDragEnter = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current++;
    setDragging(true);
  };
  const onDragOver = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDragLeave = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    depth.current = 0;
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) void importFiles(files);
  };

  const hasAssets = !!assets && assets.length > 0;

  return (
    <div
      className={`media-tab${dragging ? ' is-dropping' : ''}`}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="media-toolbar">
        <button className="btn btn-primary" title="import video, audio or image files" onClick={onPick}>
          <Upload size={14} />
          import
        </button>
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          accept={ACCEPTED_TYPES}
          onChange={(e) => onFiles(e.target.files)}
        />
        {importing > 0 ? (
          <span className="media-importing mono" title="files being imported">
            importing {importing}...
          </span>
        ) : null}
      </div>

      {hasAssets ? (
        <div className="media-filters">
          <div className="media-filter-row">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`btn btn-sm btn-ghost${filter === f.id ? ' is-active' : ''}`}
                title={`show ${f.label} assets`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div className="media-search">
            <Search size={13} />
            <input
              className="input input-sm"
              placeholder="search"
              title="search assets by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
      ) : null}

      <div className="media-scroll">
        {!hasAssets ? (
          <div className="empty">
            <Upload size={20} />
            <span>drop files here or click import</span>
          </div>
        ) : visible.length === 0 ? (
          <div className="empty">no matching assets</div>
        ) : (
          <div className="media-grid">
            {visible.map((a) => (
              <AssetCard key={a.id} asset={a} onInsert={onInsert} onRemove={onRemove} />
            ))}
          </div>
        )}
      </div>

      <Dialog
        open={!!pending}
        title="remove asset"
        onClose={cancelRemove}
        width={400}
        footer={
          <>
            <button className="btn" title="keep the asset" onClick={cancelRemove}>
              cancel
            </button>
            <button className="btn btn-danger" title="remove the asset and its clips" onClick={confirmRemove}>
              remove
            </button>
          </>
        }
      >
        <p>
          {pending
            ? `"${pending.name}" is used by ${pending.clips} clip${pending.clips === 1 ? '' : 's'} on the timeline. removing it deletes ${pending.clips === 1 ? 'that clip' : 'those clips'} too. this clears undo history.`
            : ''}
        </p>
      </Dialog>

      {dragging ? <div className="media-drop-hint">drop to import</div> : null}
    </div>
  );
}

/* ---------- text tab ---------- */

interface TextPreset {
  id: string;
  label: string;
  hint: string;
  sample: string;
  /** previews are scaled down copies of the real style */
  previewSize: number;
  weight: 400 | 700;
  boxed: boolean;
  align: 'left' | 'center';
  build(width: number, height: number): Partial<TextClip>;
}

const TEXT_PRESETS: TextPreset[] = [
  {
    id: 'title',
    label: 'title',
    hint: '120px bold',
    sample: 'title',
    previewSize: 26,
    weight: 700,
    boxed: false,
    align: 'center',
    build: () => ({ name: 'title', text: 'title', fontSize: 120, fontWeight: 700, align: 'center' }),
  },
  {
    id: 'subtitle',
    label: 'subtitle',
    hint: '64px regular',
    sample: 'subtitle',
    previewSize: 18,
    weight: 400,
    boxed: false,
    align: 'center',
    build: () => ({ name: 'subtitle', text: 'subtitle', fontSize: 64, fontWeight: 400, align: 'center' }),
  },
  {
    id: 'caption',
    label: 'caption',
    hint: '48px with box',
    sample: 'caption',
    previewSize: 14,
    weight: 700,
    boxed: true,
    align: 'center',
    build: (_w, h) => ({
      name: 'caption',
      text: 'caption',
      fontSize: 48,
      fontWeight: 700,
      align: 'center',
      background: '#000000b3',
      transform: { ...DEFAULT_TRANSFORM, y: Math.round(h * 0.35) },
    }),
  },
  {
    id: 'lower-third',
    label: 'lower third',
    hint: '56px left aligned',
    sample: 'lower third',
    previewSize: 16,
    weight: 700,
    boxed: true,
    align: 'left',
    build: (w, h) => ({
      name: 'lower third',
      text: 'lower third',
      fontSize: 56,
      fontWeight: 700,
      align: 'left',
      background: '#000000b3',
      transform: { ...DEFAULT_TRANSFORM, x: -Math.round(w * 0.28), y: Math.round(h * 0.33) },
    }),
  },
];

function canvasSize(): { w: number; h: number } {
  const p = useEditor.getState().project;
  return { w: p?.width ?? 1920, h: p?.height ?? 1080 };
}

const TextCard = memo(function TextCard({ preset }: { preset: TextPreset }) {
  const add = () => {
    const { w, h } = canvasSize();
    useEditor.getState().addText({ start: usePlayback.getState().time, preset: preset.build(w, h) });
  };
  return (
    <button
      className="media-text-card"
      draggable
      title={`add ${preset.label} text (${preset.hint}) at the playhead, or drag it onto the timeline`}
      onClick={add}
      onDragStart={(e) => {
        const { w, h } = canvasSize();
        beginDrag(e, { kind: 'text', preset: preset.build(w, h) });
      }}
      onDragEnd={endDrag}
    >
      <span className="media-text-preview">
        <span
          className={`media-text-sample${preset.boxed ? ' is-boxed' : ''}${preset.align === 'left' ? ' is-left' : ''}`}
          style={{ fontSize: preset.previewSize, fontWeight: preset.weight }}
        >
          {preset.sample}
        </span>
      </span>
      <span className="media-text-meta">
        <span className="media-text-label">{preset.label}</span>
        <span className="media-text-hint">{preset.hint}</span>
      </span>
    </button>
  );
});

function TextTab() {
  return (
    <div className="media-text-tab">
      {TEXT_PRESETS.map((p) => (
        <TextCard key={p.id} preset={p} />
      ))}
    </div>
  );
}

/* ---------- panel ---------- */

export function MediaPanel() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <div className="panel media-panel">
      <div className="tabs" role="tablist">
        <button
          className={`tab${tab === 'media' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'media'}
          title="imported files"
          onClick={() => setTab('media')}
        >
          media
        </button>
        <button
          className={`tab${tab === 'text' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'text'}
          title="text presets"
          onClick={() => setTab('text')}
        >
          text
        </button>
        <button
          className={`tab${tab === 'effects' ? ' is-active' : ''}`}
          role="tab"
          aria-selected={tab === 'effects'}
          title="effects for the timeline"
          onClick={() => setTab('effects')}
        >
          effects
        </button>
      </div>
      {tab === 'media' ? <MediaTab /> : tab === 'text' ? <TextTab /> : <EffectsTab />}
    </div>
  );
}
