/**
 * effects = full-frame webgl2 post passes. an effect is a small glsl function plus a list of
 * number params. the same code runs in the live preview, the export and the effects tab thumbnails.
 *
 * ## writing an effect (the glsl contract)
 *
 * `glsl` must define exactly:   vec4 effect(vec2 uv)
 *   uv is 0..1 across the frame, (0,0) = TOP LEFT, y grows DOWN. return the color of that pixel.
 *
 * available (declared by the prelude in glsl.ts):
 *   tex(vec2 uv)        the picture below the effect. clamp-to-edge: sampling outside 0..1 repeats
 *                       the edge pixels (that is the look we want when a picture moves or zooms out)
 *   u_time              seconds since the effect clip started
 *   u_duration          length of the effect clip in seconds
 *   u_amount            strength 0..1 (clip amount x fade in/out)
 *   u_seed              0..1000, different per clip. offset your noise with it
 *   u_size              project size in project pixels (1920x1080...). use it for pixel sized things
 *   u_res               size of the real render target in pixels (smaller than u_size in the preview)
 *   p_<key>             one float uniform per entry of `params`
 *   helpers             PI, TAU, aspect(), hash11/hash21/hash22/hash31, noise1, noise2, fbm, snoise1,
 *                       rot(), luma(), hsv2rgb(), rgb2hsv(), xform(), sat()
 *
 * rules:
 *  1. identity at u_amount = 0, and continuous in u_amount. fades ramp the effect in and out, so
 *     scale every displacement / mix by u_amount. no popping.
 *  2. deterministic: the output depends only on uv, the uniforms and the params. no gl_FragCoord
 *     (it flips between passes), no derivatives of time. random things come from hash(...) of
 *     u_seed and of a stepped time like floor(u_time * rate).
 *  3. resolution independent: the preview renders smaller than the export. express sizes as a
 *     fraction of the frame (uv units) or in project pixels through u_size, never in u_res pixels,
 *     so a 540p preview and a 4k export look the same.
 *     u_res is only for sampling footprints (1.0 / u_res = one real texel).
 *  4. keep it cheap: one pass, at most ~32 texture taps, loops with constant bounds.
 *  5. correct aspect: circles must stay round on 16:9 and 9:16. work in aspect-corrected space
 *     (multiply x by aspect()) for radial / rotational math, see xform().
 *  6. the output alpha is forced to 1. return rgb in 0..1.
 */

export type EffectCategory = 'motion' | 'blur' | 'color' | 'distort' | 'stylize';

export const EFFECT_CATEGORIES: { id: EffectCategory; label: string }[] = [
  { id: 'motion', label: 'motion' },
  { id: 'blur', label: 'blur' },
  { id: 'color', label: 'color' },
  { id: 'distort', label: 'distort' },
  { id: 'stylize', label: 'stylize' },
];

export interface EffectParam {
  /** glsl-safe identifier: lowercase letters, digits (not first), camelCase. the uniform is p_<key>. */
  key: string;
  /** short lowercase label for the inspector */
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
  /** shown after the value: '%', 'x', 'deg', 'hz', 's', 'px' */
  unit?: string;
  /**
   * a choice instead of a slider: the value is an index into these labels (0, 1, 2...).
   * min = 0, max = options.length - 1, step = 1. the inspector shows a select.
   */
  options?: string[];
}

/**
 * a temporal effect looks at the picture below it at several moments instead of one (motion blur,
 * echo). the frame renderer draws the layers below once per sample and blends them by weight.
 */
export interface TemporalSample {
  /** seconds relative to the frame time */
  offset: number;
  /** relative weight (normalized by the renderer) */
  weight: number;
}

export interface EffectDef {
  /** stable id saved in projects. lowercase-kebab. never rename once shipped. */
  id: string;
  /** lowercase display name */
  name: string;
  category: EffectCategory;
  /** one short lowercase line for tooltips */
  description: string;
  params: EffectParam[];
  /** glsl source defining `vec4 effect(vec2 uv)`. see the contract at the top of this file. */
  glsl: string;
  /** clip-local time in seconds that shows the effect well (for the still thumbnail). default 1. */
  posterTime?: number;
  /**
   * temporal effects only: the moments to blend for one frame. when present the frame renderer blends
   * the layers below at these times and `glsl` is only used for the effects tab thumbnail.
   * `quality` is 1 for export and lower for the live preview (use fewer samples).
   */
  temporal?: (params: Record<string, number>, amount: number, fps: number, quality: number) => TemporalSample[];
}

/** one effect to run on a frame */
export interface EffectPass {
  def: EffectDef;
  /** seconds since the effect clip started */
  time: number;
  /** length of the effect clip */
  duration: number;
  /** 0..1 strength after fades */
  amount: number;
  seed: number;
  /** param values. missing keys fall back to the def's default. */
  params: Record<string, number>;
}
