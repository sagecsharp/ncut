import { useMemo, useState } from 'react';
import { ArrowLeftRight } from 'lucide-react';
import { SliderField } from '../../components/ui/SliderField';
import type { Project } from '../../types';
import { tip } from '../shell/tip';
import { alphaNotes } from './alphaNotes';
import {
  AUDIO_KBPS_CHOICES,
  CODEC_HOLDS,
  DEFAULT_DELIVERY,
  DELIVERY_LABEL,
  KEY_SECONDS_CHOICES,
  MBPS_MAX,
  MBPS_MIN,
  SIZE_MAX,
  SIZE_MIN,
  TEXT,
  formatBitrate,
  mbpsOf,
  opusOnly,
} from './delivery';
import type { DeliveryAudioCodec, DeliveryCodec, ExportDelivery, ResolvedDelivery, VideoCodecChoice } from './delivery';
import { videoBitrate } from './exporter';
import type { ExportContainer, ExportQuality } from './exporter';
import { placeFrame } from './frameFit';
import type { FitMode } from './frameFit';
import type { TimeRange } from './range';
import type { DeliveryStatus } from './useDeliveryStatus';

export interface AdvancedExportProps {
  project: Project;
  container: ExportContainer;
  /** what is chosen, as chosen (the format may drop parts of it: see resolved) */
  delivery: ExportDelivery;
  resolved: ResolvedDelivery;
  onChange(next: ExportDelivery): void;
  quality: ExportQuality;
  fps: number;
  /** the size of the resolution choice, and the size of the file after the size choice */
  baseSize: { width: number; height: number };
  outSize: { width: number; height: number };
  /** the codec the plan found for the file, null = no plan (yet) */
  planCodec: string | null;
  /** the file has sound: a sound format, or a video with include audio on */
  sound: boolean;
  /** the range the export covers. null = none */
  range: TimeRange | null;
  status: DeliveryStatus;
}

interface SegOption {
  key: string;
  label: string;
  does: string;
  off?: string | null;
}

const VIDEO_ORDER: readonly VideoCodecChoice[] = ['avc', 'hevc', 'av1', 'vp9'];
const CODEC_DOES: Record<VideoCodecChoice, string> = { avc: TEXT.codecAvc, hevc: TEXT.codecHevc, av1: TEXT.codecAv1, vp9: TEXT.codecVp9 };
const clampSide = (n: number): number => Math.min(SIZE_MAX, Math.max(SIZE_MIN, Math.round(n)));

/** a choice of a few words: one radio group, a greyed button stays focusable and says why */
function Segmented({ label, value, options, onPick, onGreyed }: { label: string; value: string; options: readonly SegOption[]; onPick(key: string): void; onGreyed?(reason: string): void }) {
  return (
    <div className="export-seg" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          type="button"
          role="radio"
          aria-checked={o.key === value}
          aria-disabled={o.off ? 'true' : undefined}
          className={`btn btn-sm${o.key === value ? ' is-active' : ''}`}
          {...tip(o.label, { does: o.does, off: o.off })}
          onClick={() => {
            if (o.off) onGreyed?.(o.off);
            else onPick(o.key);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** the advanced part of the export dialog: the rows that apply to the format, from the codec to back to auto */
export function AdvancedExport({ project, container, delivery, resolved, onChange, quality, fps, baseSize, outSize, planCodec, sound, range, status }: AdvancedExportProps) {
  const [shownReason, setShownReason] = useState<string | null>(null);
  const isVideo = container === 'mp4' || container === 'webm';
  const isPicture = container === 'png' || container === 'jpg';
  const hasSoundRows = isVideo || container === 'ogg';
  const set = (patch: Partial<ExportDelivery>): void => onChange({ ...delivery, ...patch });

  const notes = useMemo(() => {
    if (!resolved.transparent || !range) return [];
    return alphaNotes(project, isPicture ? { start: range.start, end: range.start + 1 / Math.max(1, project.fps) } : range);
  }, [project, range, resolved.transparent, isPicture]);

  // ---- video codec ----
  const codecOff = (c: VideoCodecChoice): string | null => {
    if (container !== 'mp4' && container !== 'webm') return null;
    if (!(CODEC_HOLDS[container] as readonly string[]).includes(c)) return TEXT.webmHolds(DELIVERY_LABEL[c]);
    if (resolved.transparent && c !== 'vp9') return TEXT.alphaIsVp9Button;
    const s = status.video[c];
    return s && !s.ok ? s.reason : null;
  };
  const whereOf = (c: string | null): string => {
    const s = c ? status.video[c as VideoCodecChoice] : undefined;
    return s && s.ok ? (s.gpu ? TEXT.madeOnGpu : TEXT.madeOnCpu) : '';
  };
  const planned = planCodec ?? 'avc';
  const codecOptions: SegOption[] = [
    { key: 'auto', label: 'auto', does: `${TEXT.codecAuto}${whereOf(planCodec)}` },
    ...VIDEO_ORDER.map((c) => ({ key: c, label: DELIVERY_LABEL[c], does: `${CODEC_DOES[c]}${whereOf(c)}`, off: codecOff(c) })),
  ];
  // a clicked reason shows only while that codec is still greyed for the same reason
  const shownNow = shownReason && VIDEO_ORDER.some((c) => codecOff(c) === shownReason) ? shownReason : null;
  const where = (s: { gpu: boolean }): string => (s.gpu ? TEXT.onGpu : TEXT.onCpu);
  let codecStatus = '';
  if (status.checking) codecStatus = TEXT.checking;
  else if (resolved.codec === 'auto') {
    const first = (planCodec as VideoCodecChoice | null) ?? VIDEO_ORDER.find((c) => status.video[c]?.ok);
    const s = first ? status.video[first] : undefined;
    if (first && s && s.ok) codecStatus = TEXT.autoPicks(DELIVERY_LABEL[first], where(s));
  } else {
    const s = status.video[resolved.codec];
    if (s) codecStatus = s.ok ? TEXT.codecWhere(DELIVERY_LABEL[resolved.codec], where(s)) : s.reason;
  }

  // ---- bitrate ----
  const fromQuality = videoBitrate(outSize.width, outSize.height, fps, quality, planned);

  // ---- size ----
  const size = resolved.size;
  const out = outSize;
  const pa = project.width / project.height;
  const oa = out.width / out.height;
  const shapeNote =
    size && !placeFrame(project.width, project.height, out.width, out.height, size.fit).direct
      ? size.fit === 'fit'
        ? TEXT.fitNote(project.width, project.height, oa < pa ? 'above and below' : 'at the sides', resolved.transparent)
        : TEXT.fillNote(project.width, project.height, oa < pa ? 'sides are' : 'top and bottom are')
      : null;
  const roundedNote = size && isVideo && (out.width !== size.width || out.height !== size.height) ? TEXT.roundedNote(out.width, out.height) : null;
  const sizeEven = isVideo ? TEXT.sizeEvenTitle : '';

  // ---- see-through ----
  const transparentOff = container === 'mp4' ? TEXT.transparentOffMp4 : container === 'jpg' ? TEXT.transparentOffJpg : null;

  // ---- sound ----
  const soundOff = sound ? null : TEXT.audioOff;
  const audioCodec = resolved.audioCodec;
  const audioOptions: SegOption[] = (['auto', 'aac', 'opus'] as const).map((c) => {
    let off: string | null = null;
    if (c === 'aac' && container === 'webm') off = TEXT.webmAac;
    else if (c === 'aac' && container === 'ogg') off = TEXT.oggAac;
    else if (c !== 'auto') {
      const s = status.audio?.codecs[c];
      if (s && !s.ok) off = s.reason;
    }
    return {
      key: c,
      label: c,
      does: c === 'auto' ? TEXT.audioAutoDoes(container === 'mp4') : c === 'aac' ? TEXT.audioAacDoes : TEXT.audioOpusDoes,
      off: off ?? soundOff,
    };
  });
  const kbpsOptions: SegOption[] = [
    { key: 'auto', label: 'auto', does: TEXT.kbpsAutoDoes, off: soundOff },
    ...AUDIO_KBPS_CHOICES.map((k) => {
      const s = status.audio?.kbps[k];
      return { key: String(k), label: String(k), does: TEXT.kbpsDoes(k), off: (s && !s.ok ? s.reason : null) ?? soundOff };
    }),
  ];
  const rateOptions: SegOption[] = ([44100, 48000] as const).map((r) => {
    let off: string | null = null;
    if (r === 44100 && opusOnly(container, audioCodec)) off = TEXT.rateOpus;
    else {
      const s = status.audio?.rates[r];
      if (s && !s.ok) off = s.reason;
    }
    return { key: String(r), label: r === 44100 ? '44.1 khz' : '48 khz', does: r === 44100 ? TEXT.rate44Does : TEXT.rate48Does, off: off ?? soundOff };
  });
  const rateRow = (row: string | undefined) => (
    <div className="field" data-delivery-row={row}>
      <span className="field-label">sample rate</span>
      <Segmented label="sample rate" value={String(resolved.sampleRate)} options={rateOptions} onPick={(k) => set({ sampleRate: Number(k) as 44100 | 48000 })} />
    </div>
  );

  return (
    <div className="export-adv" role="group" aria-label="advanced export">
      {isVideo && (
        <div className="field" data-delivery-row="codec">
          <span className="field-label">video codec</span>
          <Segmented
            label="video codec"
            value={resolved.codec}
            options={codecOptions}
            onPick={(k) => {
              setShownReason(null);
              set({ codec: k as DeliveryCodec });
            }}
            onGreyed={setShownReason}
          />
          <div className="export-summary" role="status">
            {shownNow ?? codecStatus}
          </div>
        </div>
      )}
      {isVideo && (
        <div className="field" data-delivery-row="bitrate">
          <span className="field-label">bitrate</span>
          <div className="field-row">
            <select
              className="select"
              aria-label="bitrate"
              {...tip('bitrate', { does: TEXT.bitrateDoes })}
              value={resolved.bitrate === null ? 'quality' : 'custom'}
              onChange={(e) => {
                if (e.target.value === 'custom') set({ bitrate: Math.min(MBPS_MAX * 1e6, Math.max(MBPS_MIN * 1e6, Math.round(fromQuality / 5e5) * 5e5)) });
                else set({ bitrate: null });
              }}
            >
              <option value="quality">{TEXT.bitrateFromQuality(formatBitrate(fromQuality))}</option>
              <option value="custom">custom</option>
            </select>
            {resolved.bitrate !== null && (
              <SliderField
                value={mbpsOf(resolved.bitrate)}
                min={MBPS_MIN}
                max={MBPS_MAX}
                step={0.5}
                precision={1}
                suffix="mbps"
                ariaLabel="bitrate in mbps"
                title={TEXT.bitrateTitle}
                onStart={() => undefined}
                onChange={(v) => set({ bitrate: Math.round(v * 1e6) })}
              />
            )}
          </div>
        </div>
      )}
      {isVideo && (
        <div className="field" data-delivery-row="interval">
          <span className="field-label">key frame interval</span>
          <select
            className="select"
            aria-label="key frame interval"
            {...tip('key frame interval', { does: TEXT.intervalDoes })}
            value={resolved.keySeconds === null ? 'auto' : String(resolved.keySeconds)}
            onChange={(e) => set({ keySeconds: e.target.value === 'auto' ? null : Number(e.target.value) })}
          >
            <option value="auto">{TEXT.intervalAuto}</option>
            {KEY_SECONDS_CHOICES.filter((s) => s !== 2).map((s) => (
              <option key={s} value={String(s)}>
                {TEXT.intervalChoice(s)}
              </option>
            ))}
          </select>
        </div>
      )}
      {(isVideo || isPicture) && (
        <div className="field" data-delivery-row="size">
          <span className="field-label">size</span>
          <select
            className="select"
            aria-label="size"
            {...tip('size', { does: 'the size of the file: from the resolution choice, or a width and height of your own' })}
            value={size ? 'custom' : 'resolution'}
            onChange={(e) => set({ size: e.target.value === 'custom' ? { width: clampSide(baseSize.width), height: clampSide(baseSize.height), fit: 'fit' } : null })}
          >
            <option value="resolution">from resolution</option>
            <option value="custom">custom</option>
          </select>
          {size && (
            <>
              <div className="field-row">
                <SliderField
                  label="w"
                  suffix="px"
                  value={size.width}
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  step={1}
                  perPx={2}
                  snap={10}
                  ariaLabel="width of the file in pixels"
                  title={`${TEXT.sizeWidthTitle}${sizeEven}`}
                  onStart={() => undefined}
                  onChange={(v) => set({ size: { ...size, width: clampSide(v) } })}
                />
                <button
                  type="button"
                  className="icon-btn"
                  aria-label="swap width and height"
                  {...tip('swap', { does: 'swap width and height' })}
                  onClick={() => set({ size: { ...size, width: size.height, height: size.width } })}
                >
                  <ArrowLeftRight size={14} />
                </button>
                <SliderField
                  label="h"
                  suffix="px"
                  value={size.height}
                  min={SIZE_MIN}
                  max={SIZE_MAX}
                  step={1}
                  perPx={2}
                  snap={10}
                  ariaLabel="height of the file in pixels"
                  title={`${TEXT.sizeHeightTitle}${sizeEven}`}
                  onStart={() => undefined}
                  onChange={(v) => set({ size: { ...size, height: clampSide(v) } })}
                />
              </div>
              <select
                className="select"
                aria-label="fit or fill"
                {...tip('fit or fill', { does: TEXT.fitDoes })}
                value={size.fit}
                onChange={(e) => set({ size: { ...size, fit: e.target.value as FitMode } })}
              >
                <option value="fit">{TEXT.fitFit}</option>
                <option value="fill">{TEXT.fitFill}</option>
              </select>
              {shapeNote && <div className="export-note">{shapeNote}</div>}
              {roundedNote && <div className="export-note">{roundedNote}</div>}
            </>
          )}
        </div>
      )}
      {(isVideo || isPicture) && (
        <div className="field" data-delivery-row="transparent">
          <label className="field-row export-check" {...tip(TEXT.transparentLabel, { does: TEXT.transparentDoes, off: transparentOff })}>
            <input
              type="checkbox"
              className="checkbox"
              aria-disabled={transparentOff ? 'true' : undefined}
              checked={resolved.transparent}
              onChange={(e) => {
                if (!transparentOff) set({ transparent: e.target.checked });
              }}
            />
            <span>{TEXT.transparentLabel}</span>
          </label>
          {resolved.transparent && <div className="export-note">{TEXT.transparentInfo}</div>}
          {resolved.transparent && notes.map((n) => (
            <div key={n.text} className="export-note is-warn">
              {n.text}
            </div>
          ))}
        </div>
      )}
      {hasSoundRows && (
        <div className="field" data-delivery-row="audio">
          <span className="field-label">audio codec</span>
          <Segmented label="audio codec" value={audioCodec} options={audioOptions} onPick={(k) => set({ audioCodec: k as DeliveryAudioCodec })} />
        </div>
      )}
      {hasSoundRows && (
        <div className="field">
          <span className="field-label">audio bitrate</span>
          <Segmented
            label="audio bitrate in kbps"
            value={resolved.audioBitrate === null ? 'auto' : String(resolved.audioBitrate / 1000)}
            options={kbpsOptions}
            onPick={(k) => set({ audioBitrate: k === 'auto' ? null : Number(k) * 1000 })}
          />
        </div>
      )}
      {hasSoundRows && rateRow(undefined)}
      {container === 'wav' && rateRow('audio')}
      {resolved.notes.map((n) => (
        <div key={n} className="export-note">
          {n}
        </div>
      ))}
      <div>
        <button type="button" className="btn btn-sm" {...tip(TEXT.backToAuto, { does: TEXT.backToAutoDoes })} onClick={() => onChange({ ...DEFAULT_DELIVERY })}>
          {TEXT.backToAuto}
        </button>
      </div>
    </div>
  );
}

