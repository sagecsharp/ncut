/**
 * the pictures of a sky (Project.sky): its six sides cut out of one picture or read from six, at one face size, for the
 * renderer (loadSkyFaces), and as small samples drawn on black for the light and the seam check (sampleSky).
 * browser only (createImageBitmap, OffscreenCanvas). works in an export worker too.
 */
import type { MediaAsset, SceneSky } from '../types';
import { SKY_LAYOUTS, SKY_SAMPLE, type SkyPicture, layoutOf, skyAssets, skyKey, skyTurnsOf } from '../engine/scene3d/sky';

export type BlobOf = (assetId: string) => Blob | undefined;
type Side = ImageBitmap | OffscreenCanvas;

function giveBack(list: readonly Side[]): void {
  for (const s of list) {
    if (typeof ImageBitmap !== 'undefined' && s instanceof ImageBitmap) s.close();
    else {
      (s as OffscreenCanvas).width = 0;
      (s as OffscreenCanvas).height = 0;
    }
  }
}

/** one side of a bitmap: the cell (sx, sy, from x from) cut out and scaled to size, turned clockwise (and drawn on black for the samples) */
async function side(src: ImageBitmap, sx: number, sy: number, from: number, size: number, turn: number, onBlack: boolean): Promise<Side> {
  if (!turn && !onBlack) return createImageBitmap(src, sx, sy, from, from, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' });
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d')!;
  if (onBlack) {
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.translate(size / 2, size / 2);
  ctx.rotate((turn * Math.PI) / 2);
  ctx.drawImage(src, sx, sy, from, from, -size / 2, -size / 2, size, size);
  return onBlack ? canvas : canvas.transferToImageBitmap();
}

/** a picture that cannot be decoded (an svg, heic, a broken file), named so the user fixes the right one */
function unreadable(a: MediaAsset): never {
  throw new Error(`could not read "${a.name}"`);
}

async function sides(sky: Pick<SceneSky, 'asset' | 'faces' | 'turns'>, assets: readonly MediaAsset[], blobOf: BlobOf, size: number, onBlack: boolean): Promise<Side[]> {
  const list = skyAssets(sky as SceneSky, assets);
  if (!list) throw new Error('the sky pictures are not in the project');
  const blobs = list.map((a) => {
    const blob = blobOf(a.id);
    if (!blob) throw new Error(`the file of "${a.name}" is missing`);
    return blob;
  });
  const out: Side[] = [];
  try {
    if (list.length === 1) {
      const a = list[0]!;
      const l = SKY_LAYOUTS[layoutOf(a.width, a.height)!];
      // cut first, then scale each cell alone: scaling the whole picture would mix a cell's edge with its neighbor
      const from = Math.floor(Math.min(a.width / l.cols, a.height / l.rows));
      const whole = await createImageBitmap(blobs[0]!, { resizeWidth: l.cols * from, resizeHeight: l.rows * from, resizeQuality: 'high' }).catch(() => unreadable(a));
      try {
        for (let i = 0; i < 6; i++) {
          const [col, row] = l.cells[i]!;
          out.push(await side(whole, col * from, row * from, from, size, l.turns[i]!, onBlack));
        }
      } finally {
        whole.close();
      }
    } else {
      const turns = skyTurnsOf(sky as SceneSky);
      for (let i = 0; i < 6; i++) {
        const bmp = await createImageBitmap(blobs[i]!, { resizeWidth: size, resizeHeight: size, resizeQuality: 'high' }).catch(() => unreadable(list[i]!));
        if (turns[i]! || onBlack) {
          try {
            out.push(await side(bmp, 0, 0, size, size, turns[i]!, onBlack));
          } finally {
            bmp.close();
          }
        } else out.push(bmp);
      }
    }
  } catch (e) {
    giveBack(out);
    throw e;
  }
  return out;
}

/** 32 x 32 rgba samples of the six sides in side order, turned, drawn on black. throws with the picture's name */
export async function sampleSky(sky: Pick<SceneSky, 'asset' | 'faces' | 'turns'>, assets: readonly MediaAsset[], blobOf: BlobOf): Promise<Uint8ClampedArray[]> {
  const list = await sides(sky, assets, blobOf, SKY_SAMPLE, true);
  const out = list.map((c) => (c as OffscreenCanvas).getContext('2d')!.getImageData(0, 0, SKY_SAMPLE, SKY_SAMPLE).data);
  giveBack(list);
  return out;
}

/** the six faces at faceSize for the renderer, or null (warned once per call) when a picture cannot be read */
export async function loadSkyFaces(sky: SceneSky, assets: readonly MediaAsset[], blobOf: BlobOf, faceSize: number): Promise<SkyPicture | null> {
  try {
    const faces = (await sides(sky, assets, blobOf, faceSize, false)) as ImageBitmap[];
    let closed = false;
    return {
      key: `${skyKey(sky)}|${faceSize}`,
      size: faceSize,
      faces,
      close() {
        if (closed) return;
        closed = true;
        for (const f of faces) f.close();
      },
    };
  } catch (e) {
    console.warn('[ncut] the sky pictures could not be read', e);
    return null;
  }
}
