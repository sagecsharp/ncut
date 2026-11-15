/**
 * making a sky from media of the open project: checks the pictures, guesses the sides, runs the seam check and
 * measures the light. the user facing refusals are SkyError messages (the inspector and the mcp show them as they are).
 */
import type { MediaAsset, SceneSky } from '../types';
import { SKY_SAMPLE, guessFaces, isPanorama, layoutOf, skyTurnsOf, turnSample, withSkyValues } from '../engine/scene3d/sky';
import { measureSkyLight } from '../engine/scene3d/skyLight';
import { fitNote, fitSides } from '../engine/scene3d/skyFit';
import { useEditor } from '../store/editorStore';
import { deleteAsset, importFiles } from './importer';
import { getAssetBlob } from './registry';
import { sampleSky } from './skyFaces';

export class SkyError extends Error {}
export interface SkyMade {
  sky: SceneSky;
  /** what was changed on the way, for a toast or the mcp answer (the seam check) */
  notes: string[];
}
/** what a new sky takes over from the one before (a change of pictures keeps them). missing = turn 0, brightness 1, blur 0 */
export type SkyKeep = Partial<Pick<SceneSky, 'turn' | 'brightness' | 'blur'>>;

type Source = Pick<SceneSky, 'asset' | 'faces' | 'turns'>;

/** the media of these ids in the open project, in order. refuses what is gone or not a picture */
function pictures(ids: readonly string[]): MediaAsset[] {
  const project = useEditor.getState().project;
  if (!project) throw new SkyError('open a project first');
  return ids.map((id) => {
    const a = project.assets.find((x) => x.id === id);
    if (!a) throw new SkyError('that media is not in the project anymore');
    if (a.kind !== 'image') throw new SkyError(`"${a.name}" is not a picture`);
    if (/svg/i.test(a.mime) || /[.]svg$/i.test(a.name)) throw new SkyError(`"${a.name}" is an svg. a sky takes png, jpg, webp or avif pictures`);
    return a;
  });
}

/** the samples of a source, or a SkyError naming the picture that could not be read */
async function samplesOf(source: Source, list: readonly MediaAsset[]): Promise<Uint8ClampedArray[]> {
  const project = useEditor.getState().project;
  try {
    return await sampleSky(source, project?.assets ?? [], getAssetBlob);
  } catch (e) {
    const text = e instanceof Error ? e.message : '';
    const named = list.find((a) => text.includes(`"${a.name}"`)) ?? list[0]!;
    throw new SkyError(`could not read "${named.name}"`);
  }
}

/** the sky of a source and its samples: the light measured, the values of keep on it */
function skyOf(source: Source, samples: readonly Uint8ClampedArray[], keep: SkyKeep): SceneSky {
  const light = measureSkyLight(samples, SKY_SAMPLE);
  return withSkyValues({ ...source, turn: 0, brightness: 1, blur: 0, light }, keep);
}

/** one cross or strip picture, or six side pictures in any order named like px or right (or numbered 0..5) */
export async function skyFromAssets(ids: readonly string[], keep: SkyKeep = {}): Promise<SkyMade> {
  if (!useEditor.getState().project) throw new SkyError('open a project first');
  const unique = [...new Set(ids)];
  const list = pictures(unique);
  let source: Source;
  let words = false;
  if (list.length === 1) {
    const a = list[0]!;
    if (layoutOf(a.width, a.height) === null) {
      throw new SkyError(
        isPanorama(a.width, a.height)
          ? `"${a.name}" is a 2:1 panorama. ncut takes cube maps: a cross (4:3 or 3:4), a strip (6:1 or 1:6) or six pictures, one per side`
          : `"${a.name}" is not shaped like a cube map. ncut takes a cross (4:3 or 3:4), a strip (6:1 or 1:6) or six pictures, one per side`,
      );
    }
    source = { asset: a.id };
  } else if (list.length === 6) {
    const guess = guessFaces(list);
    if (!guess) {
      throw new SkyError('could not tell the six sides apart by their names. name them like px, nx, py, ny, pz, nz or right, left, top, bottom, front, back');
    }
    source = { faces: guess.faces };
    words = guess.words;
  } else {
    throw new SkyError(`a sky is 1 picture (a cross or a strip) or 6 pictures, one per side. this was ${list.length}`);
  }
  let samples = await samplesOf(source, list);
  const notes: string[] = [];
  if (words) {
    const fit = fitSides(samples, SKY_SAMPLE);
    const note = fitNote(fit);
    if (note) {
      const faces = [...source.faces!];
      if (fit.swap) [faces[0], faces[1]] = [faces[1]!, faces[0]!];
      const turns = [0, 0, fit.top, fit.bottom, 0, 0];
      source = turns.some((t) => t) ? { faces, turns } : { faces };
      const next = [...samples];
      if (fit.swap) [next[0], next[1]] = [next[1]!, next[0]!];
      if (fit.top) next[2] = turnSample(next[2]!, SKY_SAMPLE, fit.top);
      if (fit.bottom) next[3] = turnSample(next[3]!, SKY_SAMPLE, fit.bottom);
      samples = next;
      notes.push(`fixed the sides to fit their seams: ${note}`);
    }
  }
  return { sky: skyOf(source, samples, keep), notes };
}

/** six pictures in side order with their quarter turns, as given (no name guessing, no seam check) */
export async function skyFromFaces(faces: readonly string[], turns: readonly number[], keep: SkyKeep = {}): Promise<SkyMade> {
  if (!useEditor.getState().project) throw new SkyError('open a project first');
  if (faces.length !== 6) throw new SkyError(`a sky is 1 picture (a cross or a strip) or 6 pictures, one per side. this was ${faces.length}`);
  const list = pictures(faces);
  const t = skyTurnsOf({ turns: [...turns] } as SceneSky);
  const source: Source = t.some((v) => v) ? { faces: [...faces], turns: t } : { faces: [...faces] };
  const samples = await samplesOf(source, list);
  return { sky: skyOf(source, samples, keep), notes: [] };
}

/** import files as media and make them the sky in one go. when they are not a sky the just imported media are removed again */
export async function importSkyFiles(files: readonly File[], keep: SkyKeep = {}): Promise<SkyMade> {
  if (files.some((f) => /\.(hdr|exr)$/i.test(f.name))) {
    throw new SkyError('hdr and exr pictures cannot be read here. save the sides as png or jpg first');
  }
  const skipped: string[] = [];
  const added = await importFiles([...files], { quiet: true, onSkip: (name, why) => skipped.push(`${name} (${why})`) });
  if (added.length === 0) throw new SkyError(`none of the files could be imported${skipped.length ? `: ${skipped.join(', ')}` : ''}`);
  try {
    return await skyFromAssets(
      added.map((a) => a.id),
      keep,
    );
  } catch (e) {
    await Promise.allSettled(added.map((a) => deleteAsset(a.id)));
    throw skipped.length > 0 && e instanceof SkyError ? new SkyError(`${e.message}. skipped: ${skipped.join(', ')}`) : e;
  }
}
