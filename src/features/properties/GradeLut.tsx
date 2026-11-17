import { memo, useEffect, useMemo, useSyncExternalStore } from 'react';
import { canGrade, lutMixOf, lutOf } from '../../lib/gradeData';
import { hasAsset, getAssetBlob } from '../../media/registry';
import { lutProblem, lutTableOf, onLutChange, requestLut } from '../../media/lutTables';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import type { ClipGrade, EffectClip, MediaAsset, VisualClip } from '../../types';
import { tip } from '../shell/tip';
import { FeelField, Row } from './controls';
import { liveOpts, patchClip } from './edit';
import { applyGradeEdits } from './gradeActions';
import { importLutFor, lutOffOn, putLutOn } from './lutActions';
import { lutPatch, lutSizeText, planLutOff, planLutOn } from './lutPlan';
import type { LutPatch } from './lutPlan';

const IMPORT = ':import';
const KEEP = ':keep';
const IMPORT_TEXT = 'import a .cube file...';

const toast = (text: string): void => useUi.getState().toast(text);

/** the grade of the clip as the store has it now */
function gradeNow(id: string): ClipGrade | null | undefined {
  return (useEditor.getState().project?.clips.find((c) => c.id === id) as { grade?: ClipGrade | null } | undefined)?.grade;
}

/** the lut media of the project, in media order */
function useLutMedia(): MediaAsset[] {
  const assets = useEditor((s) => s.project?.assets);
  return useMemo(() => (assets ?? []).filter((a) => a.kind === 'lut'), [assets]);
}

/** the lut row of a grade: pick a lut, how much of it, where it sits, what it is made for */
export const GradeLut = memo(function GradeLut({ clip, locked }: { clip: VisualClip | EffectClip; locked: boolean }) {
  const id = clip.id;
  const lut = lutOf(clip.grade);
  const media = lut?.media ?? '';
  const luts = useLutMedia();
  const asset = luts.find((a) => a.id === media);
  const problem = useSyncExternalStore(onLutChange, () => (media ? lutProblem(media) : null));
  // a lut that is in the media but not read yet: ask for it (the preview does the same while it draws)
  useEffect(() => {
    if (!media || !asset || problem || lutTableOf(media) || !hasAsset(media)) return;
    void requestLut(media, getAssetBlob);
  }, [media, asset, problem]);

  const pick = (v: string): void => {
    if (v === IMPORT) {
      void importLutFor([id]).then((t) => t && toast(t));
      return;
    }
    const p = useEditor.getState().project;
    if (!p) return;
    applyGradeEdits(v === '' ? planLutOff(p.clips, p.tracks, [id]) : planLutOn(p.clips, p.tracks, [id], v));
  };
  const patch = (change: LutPatch): void => patchClip(id, { grade: lutPatch(gradeNow(id), change) });

  const options: [string, string][] = [['', 'none']];
  for (const a of luts) options.push([a.id, a.name]);
  if (lut && !asset) options.push([lut.media, 'missing lut']);
  options.push([IMPORT, IMPORT_TEXT]);

  const last = lut?.last === true;
  const tv = lut?.tv === true;
  let status = '';
  if (lut) {
    if (!asset) status = 'the lut is not in the media any more: the clip draws without it';
    else if (!hasAsset(media)) status = 'the file of this lut is missing: the clip draws without it';
    else if (problem) status = `could not read "${asset.name}" (${problem}): the clip draws without it`;
    else status = lutSizeText(asset.lut);
  }

  return (
    <div className="grade-lut" inert={locked || undefined}>
      <div className="grade-subhead">lut</div>
      <Row label="lut" title="a look up table from a .cube file: every color in, a new color out">
        <select
          className="select"
          title="a look up table from a .cube file: every color in, a new color out"
          aria-label="lut"
          value={media}
          disabled={locked}
          onChange={(e) => pick(e.target.value)}
        >
          {options.map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </select>
      </Row>
      {lut ? (
        <>
          <Row label="mix" title="how much of the lut. 100 % is the whole look, 0 % shows none of it and keeps the lut">
            <FeelField
              feel="gradeLutMix"
              title="how much of the lut. 100 % is the whole look, 0 % shows none of it and keeps the lut"
              ariaLabel="lut mix"
              value={lutMixOf(lut) * 100}
              disabled={locked}
              onChange={(v) => {
                useEditor.getState().updateClip(id, { grade: lutPatch(gradeNow(id), { mix: v / 100 }) }, liveOpts());
              }}
            />
          </Row>
          <Row label="order" title="where the lut sits in the grade">
            <div className="grade-lut-group">
              <button
                type="button"
                className={`btn btn-sm grade-lut-btn${last ? '' : ' is-active'}`}
                aria-pressed={!last}
                {...tip('lut first', { does: 'the lut gets the clip as it is, the wheels and curves work on what it gives. for camera luts (log to normal)' })}
                onClick={() => patch({ last: false })}
              >
                lut first
              </button>
              <button
                type="button"
                className={`btn btn-sm grade-lut-btn${last ? ' is-active' : ''}`}
                aria-pressed={last}
                {...tip('lut last', { does: 'the wheels and curves work on the clip, the lut gives the final look. for film looks' })}
                onClick={() => patch({ last: true })}
              >
                lut last
              </button>
            </div>
          </Row>
          <div className="props-hint">{clip.type === 'effect' ? (last ? 'runs: wheels, curves, lut' : 'runs: lut, wheels, curves') : last ? 'runs: color, wheels, curves, lut' : 'runs: color, lut, wheels, curves'}</div>
          <Row label="made for" title="what the lut expects in: most luts want 0 to 255, tv pictures use 16 to 235">
            <div className="grade-lut-group">
              <button
                type="button"
                className={`btn btn-sm grade-lut-btn${tv ? '' : ' is-active'}`}
                aria-pressed={!tv}
                {...tip('made for 0 to 255', { does: 'most luts. black is 0, white is 255' })}
                onClick={() => patch({ tv: false })}
              >
                0 to 255
              </button>
              <button
                type="button"
                className={`btn btn-sm grade-lut-btn${tv ? ' is-active' : ''}`}
                aria-pressed={tv}
                {...tip('made for 16 to 235', { does: 'only when the lut says it is made for tv pictures: black at 16, white at 235' })}
                onClick={() => patch({ tv: true })}
              >
                16 to 235
              </button>
            </div>
          </Row>
          {status ? <div className="props-hint">{status}</div> : null}
          <div className="props-buttons">
            <button
              type="button"
              className="btn btn-sm"
              {...tip('take the lut off', { does: 'the clip draws without a lut. the lut stays in the media', why: 'lut-off' })}
              onClick={() => toast(lutOffOn([id]))}
            >
              take the lut off
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
});

/** the lut of several clips: one pick for all of them. 'keep as they are' while they differ */
export function MultiGradeLut({ ids, want }: { ids: string[]; want: ReadonlySet<string> }) {
  const luts = useLutMedia();
  // one string, so the selector compares equal: '' none, the shared lut media id, else ':keep' (a gone media too)
  const value = useEditor((s) => {
    const assets = s.project?.assets ?? [];
    let shared: string | null = null;
    for (const c of s.project?.clips ?? []) {
      if (!want.has(c.id) || !canGrade(c)) continue;
      const m = lutOf((c as { grade?: ClipGrade | null }).grade)?.media ?? '';
      if (shared === null) shared = m;
      else if (shared !== m) return KEEP;
    }
    if (shared && !assets.some((a) => a.id === shared && a.kind === 'lut')) return KEEP;
    return shared ?? '';
  });
  const options: [string, string][] = [];
  if (value === KEEP) options.push([KEEP, 'keep as they are']);
  options.push(['', 'none']);
  for (const a of luts) options.push([a.id, a.name]);
  options.push([IMPORT, IMPORT_TEXT]);

  const pick = (v: string): void => {
    if (v === KEEP) return;
    if (v === IMPORT) void importLutFor(ids).then((t) => t && toast(t));
    else toast(v === '' ? lutOffOn(ids) : putLutOn(ids, v));
  };
  return (
    <Row label="lut" title="the lut of every selected clip">
      <select className="select" title="the lut of every selected clip" aria-label="lut" value={value} onChange={(e) => pick(e.target.value)}>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </Row>
  );
}
