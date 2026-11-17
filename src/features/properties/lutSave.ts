/* save the color and grade of a clip as a .cube file: 33 cubed samples of what the clip shows at a time. */
import { adjustColor, isAdjustActive } from '../../engine/clipLook';
import { gradeData, gradeLutColor } from '../../engine/grade';
import { withLuts } from '../../engine/lutScope';
import type { LutLookup } from '../../engine/lutScope';
import { GRADE_EPS, lutMixOf, lutOf } from '../../lib/gradeData';
import type { Rgb3 } from '../../lib/gradeMath';
import { resolveClip } from '../../lib/anim';
import { clamp } from '../../lib/time';
import { clipEnd } from '../../lib/timelineOps';
import { writeCube } from '../../lib/cube';
import { isVisualClip } from '../../types';
import type { Clip } from '../../types';
import { clipDisplayName } from '../timeline/effectTarget';
import { captureGrade } from './gradePlan';

/** the file name of a grade: bad file characters become -, 80 characters at most. '' gives 'grade.cube' */
export function cubeFileName(clipName: string): string {
  const safe = clipName.replace(/[\\/:*?"<>|]/g, '-').trim().slice(0, 80).trim();
  return safe === '' ? 'grade.cube' : `${safe} grade.cube`;
}

/**
 * the .cube text of a clip at a time (clamped into the clip): the color section, then the grade with its lut, as the
 * clip shows at that time. no key, dither, masks or effects. lutLeftOut: the lut could not be read, it is not in the file
 */
export function cubeOfClip(clip: Clip, time: number, lookup: LutLookup, size = 33): { name: string; text: string; lutLeftOut: boolean } {
  const t = clamp(time, clip.start, clipEnd(clip));
  const shown = resolveClip(clip, t);
  const adjust = isVisualClip(shown) && isAdjustActive(shown.adjust) ? shown.adjust! : null;
  const grade = captureGrade(clip, t);
  const d = withLuts(lookup, () => gradeData(grade));
  const lut = lutOf(grade);
  const lutLeftOut = !!lut && lutMixOf(lut) >= GRADE_EPS && lookup(lut.media) === null;
  const label = clipDisplayName(clip);
  const text = writeCube({
    title: `${label} grade`,
    size,
    comments: ['made with ncut', `the color and grade of the clip "${label}"`, 'the key, masks and effects are not in it'],
    sample: (r, g, b): Rgb3 => {
      const c: Rgb3 = [r, g, b];
      const a = adjust ? adjustColor(c, adjust) : c;
      return d ? gradeLutColor(a, d) : a;
    },
  });
  return { name: cubeFileName(label), text, lutLeftOut };
}

/** save text as a file through a temporary link (the exe asks where to save) */
export function downloadText(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
