import { memo, useRef, useState, useSyncExternalStore } from 'react';
import type { DragEvent } from 'react';
import { SKY_SIDE_WORDS, skyBlur, skyBrightness, skyCandidates, skyTurn, skyUsable, withSkyValues } from '../../engine/scene3d/sky';
import { roundShown } from '../../components/ui/numberFormat';
import { getDragPayload, isFileDrag } from '../../lib/dnd';
import { useEditor } from '../../store/editorStore';
import type { MediaAsset, SceneSky } from '../../types';
import { Row, Section, SliderRow } from './controls';
import { liveOpts } from './edit';
import { clearSkyNotes, importSky, makeSky, onSkyNotes, rearrangeSky, skyNotesOf, skyNotesState, skyPicturesLabel, swapSide, turnSide } from './skyLogic';

const setSky = (sky: SceneSky | null, live = false) => useEditor.getState().updateProject({ sky }, live ? liveOpts() : undefined);

const NO_ASSETS: readonly MediaAsset[] = [];

/** the skybox (Project.sky). shown in the project inspector between project and fog. */
export const SkySection = memo(function SkySection({ sky }: { sky: SceneSky | null | undefined }) {
  const assets = useEditor((s) => s.project?.assets) ?? NO_ASSETS;
  const notes = skyNotesOf(useSyncExternalStore(onSkyNotes, skyNotesState), sky);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  // one sky is read at a time: the buttons say so while it is
  const run = async (job: () => Promise<boolean>) => {
    setBusy(true);
    try {
      await job();
    } finally {
      setBusy(false);
    }
  };
  const onPick = (files: FileList | null) => {
    if (files && files.length > 0) void run(() => importSky(Array.from(files)));
    if (fileRef.current) fileRef.current.value = '';
  };
  const canDrop = (e: DragEvent) => isFileDrag(e) || getDragPayload()?.kind === 'asset';
  const onDragOver = (e: DragEvent) => {
    if (!canDrop(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  };
  const onDrop = (e: DragEvent) => {
    if (!canDrop(e)) return;
    e.preventDefault();
    if (isFileDrag(e)) {
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) void run(() => importSky(files));
      return;
    }
    const drag = getDragPayload();
    if (drag?.kind === 'asset') void run(() => makeSky([drag.assetId]));
  };

  const faces = sky && Array.isArray(sky.faces) && sky.faces.length === 6 ? sky.faces : null;
  const turns = [0, 1, 2, 3, 4, 5].map((i) => sky?.turns?.[i] ?? 0);
  const pictureIds = sky ? (faces ?? (sky.asset ? [sky.asset] : [])) : [];
  const picturesLabel = skyPicturesLabel(assets, pictureIds);
  const usable = !!sky && skyUsable({ sky, assets: assets as MediaAsset[] });
  const found = sky ? [] : skyCandidates(assets).slice(0, 3);

  return (
    <Section id="sky" title="sky">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} onDragOver={onDragOver} onDrop={onDrop}>
        <input ref={fileRef} type="file" accept="image/*" multiple hidden onChange={(e) => onPick(e.target.files)} />
        {!sky ? (
          <>
            <Row label="sky" title="a skybox behind every layer" wide>
              <button
                className="btn btn-sm"
                title="import a cube map: one cross or strip picture, or six pictures, one per side"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'reading...' : 'import...'}
              </button>
            </Row>
            {found.map((ids) => {
              const label = skyPicturesLabel(assets, ids);
              return (
                <Row key={ids.join(',')} label="found" title={label} wide>
                  <span className="props-grow props-clip" title={label}>
                    {label}
                  </span>
                  <button className="btn btn-sm" title="make this the sky" disabled={busy} onClick={() => void run(() => makeSky(ids))}>
                    {busy ? 'reading...' : 'use'}
                  </button>
                </Row>
              );
            })}
          </>
        ) : (
          <>
            <Row label="pictures" title={picturesLabel} wide>
              <span className="props-grow props-clip" title={picturesLabel}>
                {picturesLabel}
              </span>
              <button
                className="btn btn-sm"
                title="pick other pictures for the sky. turn, brightness and blur stay"
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {busy ? 'reading...' : 'change...'}
              </button>
              <button
                className="btn btn-sm"
                disabled={busy}
                title="remove the sky. the pictures stay in the media"
                onClick={() => {
                  clearSkyNotes();
                  setSky(null);
                }}
              >
                remove
              </button>
            </Row>
            {!usable ? (
              <div className="props-hint">the pictures of this sky are gone from the media, so it is not drawn. import it again or remove it</div>
            ) : null}
            <SliderRow
              label="turn"
              title="turn the sky around the scene (deg). 90 = its right side ahead"
              value={skyTurn(sky)}
              feel="skyTurn"
              onChange={(v) => setSky(withSkyValues(sky, { turn: v }), true)}
            />
            <SliderRow
              label="brightness"
              title="how bright the sky is (%). 100 = as the pictures are"
              value={roundShown(skyBrightness(sky) * 100, 0)}
              feel="skyBrightness"
              onChange={(v) => setSky(withSkyValues(sky, { brightness: v / 100 }), true)}
            />
            <SliderRow
              label="blur"
              title="soften the sky (%)"
              value={roundShown(skyBlur(sky) * 100, 0)}
              feel="skyBlur"
              onChange={(v) => setSky(withSkyValues(sky, { blur: v / 100 }), true)}
            />
            {faces
              ? SKY_SIDE_WORDS.map((word, i) => (
                  <Row key={word} label={word} title={`the picture on the ${word} side`}>
                    <select
                      className="select"
                      title={`the picture on the ${word} side`}
                      value={faces[i]}
                      disabled={busy}
                      onChange={(e) => {
                        const next = swapSide(faces, turns, i, e.target.value);
                        void run(() => rearrangeSky(next.faces, next.turns));
                      }}
                    >
                      {faces.map((id) => (
                        <option key={id} value={id}>
                          {assets.find((a) => a.id === id)?.name ?? id}
                        </option>
                      ))}
                    </select>
                    <button
                      className="btn btn-sm"
                      title="turn this side a quarter clockwise"
                      disabled={busy}
                      onClick={() => void run(() => rearrangeSky(faces, turnSide(turns, i)))}
                    >
                      turn
                    </button>
                  </Row>
                ))
              : null}
            {notes.length > 0 ? <div className="props-hint">{notes.join('. ')}</div> : null}
          </>
        )}
        <div className="props-hint">
          a skybox drawn behind every layer, far away, that turns with the camera. lit 3d clips take their light from it unless the project has an own light. import a cross (4:3 or 3:4), a strip (6:1 or 1:6) or six pictures named like px, nx, py, ny, pz, nz or right, left, top, bottom, front, back, or drop them here. fog does not cover it
        </div>
      </div>
    </Section>
  );
});
