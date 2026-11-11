import { memo, useCallback, useMemo } from 'react';
import { faceFit, withFace } from '../../engine/scene3d/faces';
import { useEditor } from '../../store/editorStore';
import type { ClipPatch } from '../../store/editorStore';
import type { Clip, FaceFill, FaceFit, Shape3D } from '../../types';
import { ColorField, Row, useSelectOpen } from './controls';
import { patchClip } from './edit';
import { COLOR, OWN, SAME, choiceOf, facesPatch, fillFromChoice, headChoices, rowColor, sideRows, solidsShowing, takeOffPatches, withFit } from './facesLogic';
import type { Faces, SideRow } from './facesLogic';
import { faceClipOptions } from './parentOptions';
import { currentLabel } from './selectModel';

const actions = () => useEditor.getState();

const FITS: [FaceFit, string][] = [
  ['fill', 'fill'],
  ['fit', 'fit'],
  ['stretch', 'stretch'],
];

/** write one side of a solid. a drag of a color is one undo step (live), a pick is one step of its own. */
function setFace(id: string, name: string, fill: FaceFill | null | undefined, live = false): void {
  const clip = actions().project?.clips.find((c) => c.id === id);
  if (!clip || clip.type === 'audio' || clip.type === 'effect' || clip.type === 'camera') return;
  // the store keeps an optional field set to null as "not there": a result with nothing left goes in as null
  patchClip(id, { faces: facesPatch(withFace(clip.faces, name, fill)) }, live);
}

interface RowProps {
  id: string;
  row: SideRow;
  faces: Faces | undefined;
  /** the type and fill color of the solid, for the color a row starts with */
  type: string;
  color: string | undefined;
}

/** one row: what a side shows. a clip on it gets a fit select, a color gets a color control. */
const SideRowView = memo(function SideRowView({ id, row, faces, type, color }: RowProps) {
  const { open, handlers } = useSelectOpen();
  const value = choiceOf(faces, row);
  const picked = value === SAME || value === OWN || value === COLOR ? null : value;
  // the label and type of the clip it shows (label null: gone, or not one that can be shown)
  const label = useEditor((s) => (picked && s.project ? currentLabel(faceClipOptions(s.project, id), picked) : null));
  const pickedType = useEditor((s) => (picked ? s.project?.clips.find((c) => c.id === picked)?.type : undefined));
  const clips = useEditor((s) => (open ? s.project?.clips : undefined));
  const options = useMemo(() => (open && clips ? faceClipOptions({ clips }, id) : null), [open, clips, id]);
  const near = options ? options.filter((o) => o.overlaps) : [];
  const far = options ? options.filter((o) => !o.overlaps) : [];
  const known = picked !== null && (options ? options.some((o) => o.id === picked) : label !== null);
  const title = row.label === 'all sides' ? 'what the sides without a choice of their own show' : `what the ${row.label} shows`;
  const stored = rowColor(faces, row);
  const fit = picked !== null && known && pickedType ? faceFit(faces?.[row.name] ?? null, { type: pickedType } as Pick<Clip, 'type'>) : null;
  return (
    <>
      <Row label={row.label} title={title} wide>
        <select
          className="select"
          title={title}
          aria-label={title}
          value={value}
          onChange={(e) => setFace(id, row.name, fillFromChoice(e.target.value, row, faces, { type, color }))}
          {...handlers}
        >
          {headChoices(row, faces).map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
          {picked !== null && !options ? <option value={picked}>{known ? label : 'missing clip'}</option> : null}
          {picked !== null && options && !known ? <option value={picked}>missing clip</option> : null}
          {near.length > 0 ? (
            <optgroup label="at the same time">
              {near.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null}
          {far.length > 0 ? (
            <optgroup label="other times">
              {far.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </optgroup>
          ) : null}
        </select>
        {stored !== null ? <ColorField title={`${row.label} color`} value={stored} onChange={(c) => setFace(id, row.name, { color: c }, true)} /> : null}
      </Row>
      {fit !== null ? (
        <Row label="fit" title="how the picture sits on the side: fill covers it, fit shows all of it, stretch squeezes it" wide>
          <select
            className="select"
            title="how the picture sits on the side"
            aria-label="how the picture sits on the side"
            value={fit}
            onChange={(e) => setFace(id, row.name, withFit(faces, row, e.target.value as FaceFit))}
          >
            {FITS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Row>
      ) : null}
    </>
  );
});

/** "sides": what each side of a 3d solid shows. the caller checks that the clip has sides (hasSides). */
export const FacesSection = memo(function FacesSection({ id, shape }: { id: string; shape: Shape3D }) {
  const faces = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return c && c.type !== 'audio' && c.type !== 'effect' && c.type !== 'camera' ? c.faces : undefined;
  });
  const type = useEditor((s) => s.project?.clips.find((k) => k.id === id)?.type ?? 'image');
  const color = useEditor((s) => {
    const c = s.project?.clips.find((k) => k.id === id);
    return c && c.type === 'shape' ? c.color : undefined;
  });
  return (
    <>
      {sideRows(shape).map((r) => (
        <SideRowView key={r.name} id={id} row={r} faces={faces} type={type} color={color} />
      ))}
      <div className="props-hint">a clip on a side is not drawn on its own. it shows while both clips are on screen.</div>
    </>
  );
});

/** on the inspector of a clip that is shown on the sides of solids: where, and a way to take it off */
export const OnSidesNote = memo(function OnSidesNote({ id }: { id: string }) {
  const names = useEditor((s) =>
    s.project
      ? solidsShowing(s.project, id)
          .map((x) => x.name)
          .join(', ')
      : '',
  );
  const takeOff = useCallback(() => {
    const p = actions().project;
    if (!p) return;
    const patches = takeOffPatches(p, id);
    if (patches.length === 0) return;
    // one undo step for all the solids
    actions().pushHistory();
    for (const x of patches) actions().updateClip(x.id, { faces: x.faces } as ClipPatch, { skipHistory: true });
  }, [id]);
  if (!names) return null;
  return (
    <div className="props-stat">
      <span className="props-hint">shown on the sides of {names}. not drawn on its own.</span>
      <button type="button" className="btn btn-sm" title="stop showing this clip on those sides" onClick={takeOff}>
        take off
      </button>
    </div>
  );
});
