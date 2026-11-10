import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent } from 'react';
import { ArrowLeftRight, Film, Image as ImageIcon, Layers, Music, Palette, Plus, Replace, Search, Shapes, Sparkles, Trash2, Type, Upload } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import { Dialog } from '../../components/ui/Dialog';
import { ACCEPTED_TYPES, deleteAsset, importFiles, useImporting } from '../../media/importer';
import { getThumbnail } from '../../media/derived';
import { beginDrag, endDrag, isFileDrag } from '../../lib/dnd';
import type { MediaAsset, MediaKind } from '../../types';
import { formatBytes, formatDuration } from '../../lib/time';
import { EffectsTab } from './EffectsTab';
import { TransitionsTab } from './TransitionsTab';
import { ShapesTab } from './ShapesTab';
import { LayersTab } from './LayersTab';
import { CaptionTools } from './captions/CaptionTools';
import { MEDIA_SORTS, filterAssets, sortAssets, swapKind, usedAssetIds } from './mediaList';
import type { MediaFilter, MediaSort } from './mediaList';
import { PLAIN_COLOR_NAME, plainColorPreset, showsPlainColor, usePlainColor } from './plainColor';
import { TEXT_PRESETS } from './textPresets';
import type { TextPreset } from './textPresets';
import './media.css';

type Tab = 'media' | 'layers' | 'text' | 'shapes' | 'effects' | 'transitions';
type Filter = MediaFilter;

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
  /** set when exactly one clip of a swappable kind is selected: that clip's media kind and current asset */
  swapKind: MediaKind | null;
  swapCurrent: string | null;
  onSwap: (id: string) => void;
}

const AssetCard = memo(function AssetCard({ asset, onInsert, onRemove, swapKind: selKind, swapCurrent, onSwap }: AssetCardProps) {
  const { id, kind } = asset;
  const canSwap = selKind === kind && swapCurrent !== id;
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
          {canSwap ? (
            <button
              className="icon-btn icon-btn-sm"
              title="swap into selected clip (replaces its media, keeps its place)"
              aria-label="swap into selected clip"
              onClick={(e) => {
                e.stopPropagation();
                onSwap(id);
              }}
              onDoubleClick={(e) => e.stopPropagation()}
            >
              <Replace size={14} />
            </button>
          ) : null}
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

/* ---------- plain color card ---------- */

/**
 * always the first card of the media tab, in every project: a full frame picture of one color. it is built in
 * (nothing to import, rename or remove). the swatch sets the color the next clip gets, the clip's own color is
 * changed in the properties afterwards.
 */
const PlainColorCard = memo(function PlainColorCard() {
  const color = usePlainColor((s) => s.color);
  const preset = () => {
    const { w, h } = canvasSize();
    return plainColorPreset(w, h, usePlainColor.getState().color);
  };
  // addShape selects the new clip itself
  const insert = () => useEditor.getState().addShape({ start: usePlayback.getState().time, preset: preset() });
  return (
    <div
      className="media-card media-card-plain"
      draggable
      tabIndex={0}
      title={`${PLAIN_COLOR_NAME} - a full frame picture of one color, in every project. double click to add it at the playhead, or drag it onto the timeline`}
      onDragStart={(e) => beginDrag(e, { kind: 'shape', preset: preset() })}
      onDragEnd={endDrag}
      onDoubleClick={insert}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || e.key !== 'Enter') return;
        e.preventDefault();
        insert();
      }}
    >
      <div className="media-thumb is-plain" style={{ background: color }}>
        <span className="media-badge media-badge-kind">
          <ImageIcon size={12} />
        </span>
        <span className="media-plain-pick" title="pick the color the next plain color clip gets">
          <Palette size={12} />
          <input
            type="color"
            aria-label="plain color"
            value={color}
            draggable={false}
            onChange={(e) => usePlainColor.getState().setColor(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          />
        </span>
        <div className="media-actions">
          <button
            className="icon-btn icon-btn-sm"
            title="add to timeline at the playhead"
            aria-label="add plain color to timeline"
            onClick={(e) => {
              e.stopPropagation();
              insert();
            }}
            onDoubleClick={(e) => e.stopPropagation()}
          >
            <Plus size={14} />
          </button>
        </div>
      </div>
      <div className="media-name">{PLAIN_COLOR_NAME}</div>
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
  const [unusedOnly, setUnusedOnly] = useState(false);
  const [sort, setSort] = useState<MediaSort>('added');
  const [pending, setPending] = useState<PendingRemove | null>(null);

  const onInsert = useCallback((id: string) => {
    useEditor.getState().insertAsset(id, { start: usePlayback.getState().time });
  }, []);

  // one selected clip that holds media: its kind and asset (a string, so the selector stays stable)
  const swapSel = useEditor((s) => {
    const p = s.project;
    if (!p || s.selection.length !== 1) return '';
    const c = p.clips.find((x) => x.id === s.selection[0]);
    const k = swapKind(c);
    return k ? `${k}|${(c as { assetId: string }).assetId}` : '';
  });
  const [selKind, selAsset] = swapSel ? (swapSel.split('|') as [MediaKind, string]) : [null, null];
  // the clips are only read while the filter is on, so other edits do not re-render the grid
  const clipsForUsed = useEditor((s) => (unusedOnly ? s.project?.clips : undefined));

  const onSwap = useCallback((assetId: string) => {
    const st = useEditor.getState();
    if (st.selection.length !== 1) return;
    if (!st.replaceClipAsset(st.selection[0]!, assetId)) useUi.getState().toast('could not swap that in. the track may be locked.', 'error');
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
    const used = unusedOnly && clipsForUsed ? usedAssetIds(clipsForUsed) : new Set<string>();
    return sortAssets(filterAssets(assets, { kind: filter, query, unusedOnly, used }), sort);
  }, [assets, filter, query, unusedOnly, clipsForUsed, sort]);

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
  // without imported files the filters are not on screen: nothing may hide the card then
  const showPlain = !hasAssets || showsPlainColor({ kind: filter, query, unusedOnly });

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
            <button
              className={`btn btn-sm btn-ghost${unusedOnly ? ' is-active' : ''}`}
              title="only show assets that no clip uses"
              aria-pressed={unusedOnly}
              onClick={() => setUnusedOnly((v) => !v)}
            >
              not used
            </button>
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
            <select
              className="select media-sort"
              title="sort assets"
              aria-label="sort assets"
              value={sort}
              onChange={(e) => setSort(e.target.value as MediaSort)}
            >
              {MEDIA_SORTS.map((o) => (
                <option key={o.id} value={o.id} title={o.tip}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      ) : null}

      <div className="media-scroll">
        {showPlain || (hasAssets && visible.length > 0) ? (
          <div className="media-grid">
            {showPlain ? <PlainColorCard /> : null}
            {hasAssets
              ? visible.map((a) => (
                  <AssetCard
                    key={a.id}
                    asset={a}
                    onInsert={onInsert}
                    onRemove={onRemove}
                    swapKind={selKind}
                    swapCurrent={selAsset}
                    onSwap={onSwap}
                  />
                ))
              : null}
          </div>
        ) : (
          <div className="empty">no matching assets</div>
        )}
        {!hasAssets ? (
          <div className="empty media-empty-import">
            <Upload size={20} />
            <span>drop video, audio or image files here</span>
            <span className="media-empty-sub">or pick them from your computer. files stay in this browser.</span>
            <button className="btn" title="import video, audio or image files" onClick={onPick}>
              <Upload size={14} />
              import files
            </button>
          </div>
        ) : null}
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

function canvasSize(): { w: number; h: number } {
  const p = useEditor.getState().project;
  return { w: p?.width ?? 1920, h: p?.height ?? 1080 };
}

const TextCard = memo(function TextCard({ preset }: { preset: TextPreset }) {
  const look = preset.look ?? {};
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
          className={`media-text-sample${preset.boxed ? ' is-boxed' : ''}${preset.align === 'left' ? ' is-left' : ''}${look.pill ? ' is-pill' : ''}${look.stroke ? ' is-stroke' : ''}`}
          style={{
            fontSize: preset.previewSize,
            fontWeight: preset.weight,
            fontFamily: look.family,
            textTransform: look.upper ? 'uppercase' : undefined,
            letterSpacing: look.spacing ? `${look.spacing}em` : undefined,
          }}
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
      <CaptionTools />
      {TEXT_PRESETS.map((p) => (
        <TextCard key={p.id} preset={p} />
      ))}
    </div>
  );
}

/* ---------- panel ---------- */

const TABS: { id: Tab; label: string; tip: string; icon: LucideIcon }[] = [
  { id: 'media', label: 'media', tip: 'imported files', icon: Film },
  { id: 'layers', label: 'layers', tip: 'everything on screen right now', icon: Layers },
  { id: 'text', label: 'text', tip: 'text presets', icon: Type },
  { id: 'shapes', label: 'shapes', tip: 'shapes and backgrounds', icon: Shapes },
  { id: 'effects', label: 'effects', tip: 'effects for the timeline', icon: Sparkles },
  { id: 'transitions', label: 'transitions', tip: 'transitions between clips', icon: ArrowLeftRight },
];

export function MediaPanel() {
  const [tab, setTab] = useState<Tab>('media');
  return (
    <div className="panel media-panel">
      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            className={`tab${tab === t.id ? ' is-active' : ''}`}
            role="tab"
            aria-selected={tab === t.id}
            aria-label={t.label}
            title={t.tip}
            onClick={() => setTab(t.id)}
          >
            <t.icon className="media-tab-icon" size={14} />
            <span className="media-tab-label">{t.label}</span>
          </button>
        ))}
      </div>
      {tab === 'media' ? (
        <MediaTab />
      ) : tab === 'layers' ? (
        <LayersTab />
      ) : tab === 'text' ? (
        <TextTab />
      ) : tab === 'shapes' ? (
        <ShapesTab />
      ) : tab === 'effects' ? (
        <EffectsTab />
      ) : (
        <TransitionsTab />
      )}
    </div>
  );
}
