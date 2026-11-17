import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent } from 'react';
import { ArrowLeftRight, Film, Image as ImageIcon, Layers, Music, Palette, Plus, Replace, Search, Shapes, SlidersVertical, Sparkles, SwatchBook, Trash2, Type, Upload } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useUi } from '../../store/ui';
import type { MediaTabId } from '../../store/ui';
import { addMedia, openInSource } from '../preview/sourceKeys';
import { putLutOn } from '../properties/lutActions';
import { REASON_TEXT } from '../shell/reasons';
import { useSource } from '../../store/source';
import { useSourcePrefs } from '../preview/sourcePrefs';
import { frameAt } from '../../lib/inOut';
import { marksOf } from '../../lib/marks';
import { Dialog } from '../../components/ui/Dialog';
import { ACCEPTED_TYPES, deleteAsset, importFiles, useImporting } from '../../media/importer';
import { getThumbnail } from '../../media/derived';
import { beginDrag, endDrag, isFileDrag } from '../../lib/dnd';
import { skyUses } from '../../engine/scene3d/sky';
import { offerSky, removeAssetText } from '../properties/skyLogic';
import type { MediaAsset, MediaKind } from '../../types';
import { formatBytes, formatDuration } from '../../lib/time';
import { EffectsTab } from './EffectsTab';
import { TransitionsTab } from './TransitionsTab';
import { MixerPanel } from './MixerPanel';
import { ShapesTab } from './ShapesTab';
import { LayersTab } from './LayersTab';
import { CaptionTools } from './captions/CaptionTools';
import { MEDIA_SORTS, filterAssets, lutSizeText, lutUses, removeLutText, sortAssets, swapKind, usedAssetIds } from './mediaList';
import type { MediaFilter, MediaSort } from './mediaList';
import { PLAIN_COLOR_NAME, plainColorPreset, showsPlainColor, usePlainColor } from './plainColor';
import { tip } from '../shell/tip';
import { TEXT_PRESETS } from './textPresets';
import type { TextPreset } from './textPresets';
import { CardSkim } from './CardSkim';
import { FLIP_DELAY_MS, marksBar, marksTitle, restoreModeFor } from './cardMath';
import type { CardPress } from './cardMath';
import './media.css';

type Filter = MediaFilter;

const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'all' },
  { id: 'video', label: 'video' },
  { id: 'audio', label: 'audio' },
  { id: 'image', label: 'image' },
  { id: 'lut', label: 'luts' },
];

function KindIcon({ kind, size = 12 }: { kind: MediaKind; size?: number }) {
  if (kind === 'video') return <Film size={size} />;
  if (kind === 'audio') return <Music size={size} />;
  if (kind === 'lut') return <SwatchBook size={size} />;
  return <ImageIcon size={size} />;
}

/* ---------- asset card ---------- */

/** the last press on a card, and the timer that flips the preview to the source view after it (a double click cancels it) */
let cardPress: CardPress | null = null;
let flipTimer: ReturnType<typeof setTimeout> | null = null;

const cancelFlip = () => {
  if (flipTimer !== null) clearTimeout(flipTimer);
  flipTimer = null;
};

interface AssetCardProps {
  asset: MediaAsset;
  /** this media is the one in the source view */
  inSource: boolean;
  /** the mouse over a video card shows its frames */
  skim: boolean;
  fps: number;
  onInsert: (id: string) => void;
  onRemove: (id: string) => void;
  /** set when exactly one clip of a swappable kind is selected: that clip's media kind and current asset */
  swapKind: MediaKind | null;
  swapCurrent: string | null;
  onSwap: (id: string) => void;
}

const AssetCard = memo(function AssetCard({ asset, inSource, skim, fps, onInsert, onRemove, swapKind: selKind, swapCurrent, onSwap }: AssetCardProps) {
  const { id, kind } = asset;
  const canSwap = selKind === kind && swapCurrent !== id;
  const cardRef = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(false);
  const [thumb, setThumb] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(asset.name);
  // the time under the mouse on a skimmed card, and what it was when the button went down (the skim clears it by then)
  const skimRef = useRef<number | null>(null);
  const pressTime = useRef<number | null>(null);

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
      if (e.shiftKey) {
        if (kind === 'lut') useUi.getState().toast(REASON_TEXT.lutNotClip);
        else openInSource(id);
      } else onInsert(id);
    }
  };

  // a click shows the media in the source view: at once when both views show, else after FLIP_DELAY_MS (a double click adds it instead)
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || e.detail !== 1 || editing) return;
    if (e.target instanceof Element && e.target.closest('.media-actions, .media-name, .media-rename')) return;
    const time = pressTime.current === null ? undefined : frameAt(pressTime.current, fps);
    cancelFlip();
    // a lut is no source: the click only focuses
    if (kind === 'lut') {
      cardPress = null;
      return;
    }
    if (useSource.getState().split) {
      cardPress = null;
      openInSource(id, time);
      return;
    }
    const prevMode = useUi.getState().previewMode;
    cardPress = { id, at: performance.now(), prevMode, flipped: false };
    flipTimer = setTimeout(() => {
      flipTimer = null;
      openInSource(id, time);
      cardPress = { id, at: performance.now(), prevMode, flipped: true };
    }, FLIP_DELAY_MS);
  };

  // a double click adds the media. one that came after the flip puts the old view back
  const onDoubleClick = () => {
    cancelFlip();
    onInsert(id);
    const back = restoreModeFor(cardPress, id, performance.now());
    if (back) useUi.getState().setPreviewMode(back);
    cardPress = null;
  };

  const marks = marksOf(asset);
  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    if (kind === 'lut') beginDrag(e, { kind: 'lut', assetId: id });
    else beginDrag(e, { kind: 'asset', assetId: id, ...(marks ? { range: marks } : {}) });
  };

  const dims = asset.width && asset.height ? ` - ${asset.width}x${asset.height}` : '';
  const info = kind === 'lut' ? `${asset.name}: a lut. drag it onto a clip, or double click to put it on the selected clips` : `${asset.name} - ${formatBytes(asset.size)}${dims}`;
  const bar = marksBar(marks, asset.duration);

  return (
    <div
      ref={cardRef}
      className={`media-card${inSource ? ' is-source' : ''}`}
      data-asset-id={id}
      draggable={!editing}
      tabIndex={0}
      title={marks ? marksTitle(info, marks, asset.duration, fps) : info}
      onPointerDownCapture={() => {
        pressTime.current = skimRef.current;
      }}
      onClick={onClick}
      onDragStart={onDragStart}
      onDragEnd={endDrag}
      onDoubleClick={onDoubleClick}
      onKeyDown={onKeyDown}
    >
      <div className={`media-thumb is-${kind}`}>
        {thumb ? <img className="media-thumb-img" src={thumb} alt="" draggable={false} /> : <KindIcon kind={kind} size={22} />}
        {kind === 'video' && skim ? <CardSkim asset={asset} timeRef={skimRef} /> : null}
        <span className="media-badge media-badge-kind">
          <KindIcon kind={kind} />
        </span>
        {kind === 'lut' ? (
          <span className="media-badge media-badge-dur">{lutSizeText(asset.lut)}</span>
        ) : kind !== 'image' ? (
          <span className="media-badge media-badge-dur mono">{formatDuration(asset.duration)}</span>
        ) : null}
        {bar ? <span className="media-marks" aria-hidden="true" style={{ left: `${bar.left}%`, width: `${bar.width}%` }} /> : null}
        <div className="media-actions">
          <button
            className="icon-btn icon-btn-sm"
            {...(kind === 'lut'
              ? tip('put on selected clips', { does: 'puts this lut in the grade of the selected clips', why: 'lut-on' })
              : tip('add to timeline', { does: 'at the playhead. the marked part when the media has an in or out point' }))}
            aria-label={kind === 'lut' ? 'put the lut on the selected clips' : 'add to timeline'}
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
              {...tip('swap into selected clip', { does: 'the selected clip shows this media instead. its place and look stay' })}
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
            {...tip('remove from project', {
              does: kind === 'lut' ? 'the lut, and takes it off the grade of every clip that uses it' : 'the media and every clip that uses it',
            })}
            aria-label="remove from project"
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
          title="media name"
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
  inSky: boolean;
  /** a lut some clips use: the dialog says this instead */
  lutText?: string;
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

  // the media in the source view gets an outline, the skim and the project's fps reach every card as plain props
  const sourceId = useSource((s) => s.assetId);
  const skim = useSourcePrefs((s) => s.skim);
  const fps = useEditor((s) => s.project?.fps ?? 30);

  // addMedia takes the marked part and calls insertMedia, so separate sound still works
  const onInsert = useCallback((id: string) => {
    const st = useEditor.getState();
    if (st.project?.assets.find((a) => a.id === id)?.kind === 'lut') {
      const t = putLutOn(st.selection, id);
      if (t) useUi.getState().toast(t);
      return;
    }
    addMedia(id, { start: usePlayback.getState().time });
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
  const skyForUsed = useEditor((s) => (unusedOnly ? s.project?.sky : undefined));

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
    if (asset.kind === 'lut') {
      const n = lutUses(project.clips, id);
      if (n > 0) setPending({ id, name: asset.name, clips: n, inSky: false, lutText: removeLutText(asset.name, n) });
      else void deleteAsset(id);
      return;
    }
    const clips = project.clips.filter((c) => 'assetId' in c && c.assetId === id).length;
    const inSky = skyUses(project.sky, id);
    if (clips > 0 || inSky) setPending({ id, name: asset.name, clips, inSky });
    else void deleteAsset(id);
  }, []);

  const confirmRemove = useCallback(() => {
    if (pending) void deleteAsset(pending.id);
    setPending(null);
  }, [pending]);
  const cancelRemove = useCallback(() => setPending(null), []);

  const visible = useMemo(() => {
    if (!assets) return [];
    const used = unusedOnly && clipsForUsed ? usedAssetIds(clipsForUsed, skyForUsed) : new Set<string>();
    return sortAssets(filterAssets(assets, { kind: filter, query, unusedOnly, used }), sort);
  }, [assets, filter, query, unusedOnly, clipsForUsed, skyForUsed, sort]);

  const onPick = () => fileRef.current?.click();
  const onFiles = (files: FileList | null) => {
    if (files && files.length > 0) void importFiles(Array.from(files)).then(offerSky);
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
    if (files.length > 0) void importFiles(files).then(offerSky);
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
        <button className="btn btn-primary" title="import video, audio, image or .cube lut files" onClick={onPick}>
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
                title={f.id === 'all' ? 'show all media' : `show only ${f.label}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label}
              </button>
            ))}
            <button
              className={`btn btn-sm btn-ghost${unusedOnly ? ' is-active' : ''}`}
              title="only show media that no clip uses"
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
              title="search media by name"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <select
              className="select media-sort"
              title="sort media"
              aria-label="sort media"
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
                    inSource={sourceId === a.id}
                    skim={skim}
                    fps={fps}
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
          <div className="empty">no matching media</div>
        )}
        {!hasAssets ? (
          <div className="empty media-empty-import">
            <Upload size={20} />
            <span>drop video, audio, image or .cube lut files here</span>
            <span className="media-empty-sub">or pick them from your computer. files stay in this browser.</span>
            <button className="btn" title="import video, audio, image or .cube lut files" onClick={onPick}>
              <Upload size={14} />
              import files
            </button>
          </div>
        ) : null}
      </div>

      <Dialog
        open={!!pending}
        title="remove media"
        onClose={cancelRemove}
        width={400}
        footer={
          <>
            <button className="btn" title="keep the media" onClick={cancelRemove}>
              cancel
            </button>
            <button className="btn btn-danger" title={pending?.lutText ? 'remove the lut' : 'remove the media and its clips'} onClick={confirmRemove}>
              remove
            </button>
          </>
        }
      >
        <p>
          {pending ? (pending.lutText ?? removeAssetText(pending.name, pending.clips, pending.inSky)) : ''}
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

const TABS: { id: MediaTabId; label: string; tip: string; icon: LucideIcon; keys?: string }[] = [
  { id: 'media', label: 'media', tip: 'the files you imported', icon: Film },
  { id: 'layers', label: 'layers', tip: 'every clip on screen now, attached clips under their clip', icon: Layers },
  { id: 'text', label: 'text', tip: 'text presets and captions', icon: Type },
  { id: 'shapes', label: 'shapes', tip: 'shapes and backgrounds', icon: Shapes },
  { id: 'effects', label: 'effects', tip: 'drop one on a track to change everything below, or alt drop it on a clip for that clip only', icon: Sparkles },
  { id: 'transitions', label: 'transitions', tip: 'drop one on a cut or on selected clips', icon: ArrowLeftRight },
  { id: 'mixer', label: 'mixer', tip: 'one strip per track with sound: level, pan, mute, solo and meters, plus the output', icon: SlidersVertical, keys: 'open-mixer' },
];

export function MediaPanel() {
  const tab = useUi((s) => s.mediaTab);
  const setTab = useUi((s) => s.setMediaTab);
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
            {...tip(t.label, { does: t.tip, keys: t.keys })}
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
      ) : tab === 'mixer' ? (
        <MixerPanel />
      ) : (
        <TransitionsTab />
      )}
    </div>
  );
}
