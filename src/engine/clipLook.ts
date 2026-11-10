/**
 * per-clip picture processing: color correction (clip.adjust) and chroma key (clip.chromaKey).
 * runs on the clip's own picture before it is placed, so a keyed clip really is see-through and
 * whatever is under it shows.
 *
 * the color math exists twice: as glsl (FRAGMENT_SRC, what actually runs) and as typescript
 * (adjustColor / keyAlpha / despill, what the tests run). THEY MUST MATCH line by line: when you
 * change one, change the other.
 *
 * order per pixel (straight, un-premultiplied color): key alpha + despill on the original color,
 * then color adjust, then alpha = source alpha * key alpha, then premultiply for the output.
 */
import type { ChromaKey, ClipAdjust, VisualClip } from '../types';
import { createCanvas } from '../lib/canvas';

export const DEFAULT_ADJUST: ClipAdjust = { brightness: 0, contrast: 0, saturation: 0, hue: 0, temperature: 0 };
export const DEFAULT_CHROMA_KEY: ChromaKey = { color: '#00d000', tolerance: 0.3, softness: 0.1, spill: 0.5 };

export type Rgb = [number, number, number];

const MAX_SIDE = 4096;
/** chroma distances are multiplied by this so tolerance 0..1 spans every possible color */
const KEY_DIST_SCALE = 1.5;
/** below this brightness the chroma is not boosted further (keeps dark noise from being keyed) */
const KEY_NORM_FLOOR = 0.25;
/** a key color needs at least this much max-min to count as a color (else no despill) */
const KEY_MIN_CHROMA = 0.1;
/** how much red/blue move at temperature +-1 (green compensates to keep the luma) */
const TEMP_SHIFT = 0.1;
const TEMP_G = (TEMP_SHIFT * (0.2126 - 0.0722)) / 0.7152;

const NO_MASK: Rgb = [0, 0, 0];
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** true when the adjust values would change the picture */
export function isAdjustActive(adjust: ClipAdjust | null | undefined): boolean {
  if (!adjust) return false;
  return (
    Math.abs(num(adjust.brightness)) > 1e-4 ||
    Math.abs(num(adjust.contrast)) > 1e-4 ||
    Math.abs(num(adjust.saturation)) > 1e-4 ||
    Math.abs(num(adjust.hue)) > 1e-4 ||
    Math.abs(num(adjust.temperature)) > 1e-4
  );
}

/** '#rgb' / '#rrggbb' (leading # optional, any case) to 0..1 rgb. null when it is not a color. */
export function parseHexColor(hex: unknown): Rgb | null {
  if (typeof hex !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h[0]! + h[0]! + h[1]! + h[1]! + h[2]! + h[2]!;
  const n = parseInt(h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

let lastHex = '';
let lastRgb: Rgb | null = null;
function keyRgb(key: ChromaKey | null | undefined): Rgb | null {
  if (!key) return null;
  if (key.color !== lastHex) {
    lastHex = key.color;
    lastRgb = parseHexColor(key.color);
  }
  return lastRgb;
}

/** true when the key would do something (it has a usable color) */
export function isKeyActive(key: ChromaKey | null | undefined): boolean {
  return keyRgb(key) !== null;
}

/** true when the clip's picture has to go through clipLookTexture */
export function hasClipLook(clip: VisualClip): boolean {
  return isAdjustActive(clip.adjust) || isKeyActive(clip.chromaKey);
}

/** a string that changes whenever the result of clipLookTexture would (for texture caches) */
export function clipLookSignature(clip: VisualClip): string {
  const a = isAdjustActive(clip.adjust) ? clip.adjust! : null;
  const k = isKeyActive(clip.chromaKey) ? clip.chromaKey! : null;
  if (!a && !k) return '';
  let s = '';
  if (a) s += `a${num(a.brightness)},${num(a.contrast)},${num(a.saturation)},${num(a.hue)},${num(a.temperature)}`;
  if (k) {
    const c = keyRgb(k)!;
    s += `|k${c[0].toFixed(4)},${c[1].toFixed(4)},${c[2].toFixed(4)},${num(k.tolerance)},${num(k.softness)},${num(k.spill)}`;
  }
  return s;
}

// ---------------------------------------------------------------------------------------------
// glsl (keep in sync with the typescript below)
// ---------------------------------------------------------------------------------------------

const VERTEX_SRC = `#version 300 es
out vec2 v_uv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
  v_uv = vec2(p.x, 1.0 - p.y);
}`;

const FRAGMENT_SRC = `#version 300 es
precision highp float;
uniform sampler2D u_tex;
uniform vec4 u_adj;     // brightness, contrast, saturation, temperature
uniform vec2 u_hue;     // cos, sin of the hue angle
uniform float u_keyOn;  // 1 when keying
uniform vec2 u_keyCbCr; // chroma of the key color
uniform vec3 u_key;     // tolerance, softness, spill
uniform vec3 u_mask;    // one-hot dominant channel of the key color, 0 = no despill
in vec2 v_uv;
out vec4 o;

vec2 chromaOf(vec3 c) {
  c /= max(max(c.r, max(c.g, c.b)), ${KEY_NORM_FLOOR.toFixed(2)});
  return vec2(
    -0.168736 * c.r - 0.331264 * c.g + 0.5 * c.b,
    0.5 * c.r - 0.418688 * c.g - 0.081312 * c.b
  );
}

vec3 hueRot(vec3 c, float cs, float sn) {
  return vec3(
    dot(c, vec3(0.213 + cs * 0.787 - sn * 0.213, 0.715 - cs * 0.715 - sn * 0.715, 0.072 - cs * 0.072 + sn * 0.928)),
    dot(c, vec3(0.213 - cs * 0.213 + sn * 0.143, 0.715 + cs * 0.285 + sn * 0.140, 0.072 - cs * 0.072 - sn * 0.283)),
    dot(c, vec3(0.213 - cs * 0.213 - sn * 0.787, 0.715 - cs * 0.715 + sn * 0.715, 0.072 + cs * 0.928 + sn * 0.072))
  );
}

void main() {
  vec4 s = texture(u_tex, v_uv);
  vec3 c = s.rgb;
  float a = s.a;
  if (u_keyOn > 0.5) {
    float d = distance(chromaOf(c), u_keyCbCr) * ${KEY_DIST_SCALE.toFixed(2)};
    a *= smoothstep(u_key.x, max(u_key.x + u_key.y, u_key.x + 0.0001), d);
    float dom = dot(c, u_mask);
    float oth = max(max(c.r * (1.0 - u_mask.r), c.g * (1.0 - u_mask.g)), c.b * (1.0 - u_mask.b));
    c -= u_mask * max(dom - oth, 0.0) * u_key.z;
  }
  // temperature (luma kept roughly constant)
  c += vec3(${TEMP_SHIFT} * u_adj.w, -${TEMP_G.toFixed(6)} * u_adj.w, -${TEMP_SHIFT} * u_adj.w);
  c = clamp(c, 0.0, 1.0);
  // brightness
  if (u_adj.x < 0.0) c = c * (1.0 + u_adj.x); else c = c + (1.0 - c) * u_adj.x;
  // contrast around mid gray
  float f = u_adj.y < 0.0 ? 1.0 + u_adj.y : 1.0 + 2.0 * u_adj.y;
  c = clamp((c - 0.5) * f + 0.5, 0.0, 1.0);
  // saturation (rec. 709 luma)
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = clamp(vec3(l) + (c - vec3(l)) * (1.0 + u_adj.z), 0.0, 1.0);
  // hue
  c = clamp(hueRot(c, u_hue.x, u_hue.y), 0.0, 1.0);
  o = vec4(c * a, a);
}`;

// ---------------------------------------------------------------------------------------------
// the same math in typescript (keep in sync with the glsl above)
// ---------------------------------------------------------------------------------------------

/** color correction on a straight (un-premultiplied) 0..1 color. all zero = identity. */
export function adjustColor(rgb: Rgb, adjust: ClipAdjust): Rgb {
  const br = clamp(num(adjust.brightness), -1, 1);
  const ct = clamp(num(adjust.contrast), -1, 1);
  const sat = clamp(num(adjust.saturation), -1, 1);
  const tmp = clamp(num(adjust.temperature), -1, 1);
  const rad = (num(adjust.hue) * Math.PI) / 180;
  const cs = Math.cos(rad);
  const sn = Math.sin(rad);
  // temperature
  let r = clamp01(rgb[0] + TEMP_SHIFT * tmp);
  let g = clamp01(rgb[1] - TEMP_G * tmp);
  let b = clamp01(rgb[2] - TEMP_SHIFT * tmp);
  // brightness
  if (br < 0) {
    r *= 1 + br;
    g *= 1 + br;
    b *= 1 + br;
  } else {
    r += (1 - r) * br;
    g += (1 - g) * br;
    b += (1 - b) * br;
  }
  // contrast
  const f = ct < 0 ? 1 + ct : 1 + 2 * ct;
  r = clamp01((r - 0.5) * f + 0.5);
  g = clamp01((g - 0.5) * f + 0.5);
  b = clamp01((b - 0.5) * f + 0.5);
  // saturation
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  r = clamp01(l + (r - l) * (1 + sat));
  g = clamp01(l + (g - l) * (1 + sat));
  b = clamp01(l + (b - l) * (1 + sat));
  // hue
  const hr = r * (0.213 + cs * 0.787 - sn * 0.213) + g * (0.715 - cs * 0.715 - sn * 0.715) + b * (0.072 - cs * 0.072 + sn * 0.928);
  const hg = r * (0.213 - cs * 0.213 + sn * 0.143) + g * (0.715 + cs * 0.285 + sn * 0.14) + b * (0.072 - cs * 0.072 - sn * 0.283);
  const hb = r * (0.213 - cs * 0.213 - sn * 0.787) + g * (0.715 - cs * 0.715 + sn * 0.715) + b * (0.072 + cs * 0.928 + sn * 0.072);
  return [clamp01(hr), clamp01(hg), clamp01(hb)];
}

/** chroma (cb, cr) of a color, brightness-normalized so dark and bright screens compare alike */
function chromaOf(r: number, g: number, b: number): [number, number] {
  const m = Math.max(r, g, b, KEY_NORM_FLOOR);
  r /= m;
  g /= m;
  b /= m;
  return [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

/**
 * how opaque a pixel stays after keying, 0..1: smoothstep over the distance between the pixel's
 * chroma and the key color's chroma (distance 0 = the key color, fully removed).
 */
export function keyAlpha(rgb: Rgb, key: ChromaKey): number {
  const k = keyRgb(key);
  if (!k) return 1;
  const kc = chromaOf(k[0], k[1], k[2]);
  const pc = chromaOf(rgb[0], rgb[1], rgb[2]);
  const d = Math.hypot(pc[0] - kc[0], pc[1] - kc[1]) * KEY_DIST_SCALE;
  const tol = num(key.tolerance);
  const soft = num(key.softness);
  return smoothstep(tol, Math.max(tol + soft, tol + 0.0001), d);
}

/** one-hot mask of the key color's dominant channel, or null for gray-ish keys (no despill) */
function despillMask(k: Rgb): Rgb | null {
  const mx = Math.max(k[0], k[1], k[2]);
  if (mx - Math.min(k[0], k[1], k[2]) < KEY_MIN_CHROMA) return null;
  return k[0] === mx ? [1, 0, 0] : k[1] === mx ? [0, 1, 0] : [0, 0, 1];
}

/**
 * classic despill generalized to any key color: take the key color's dominant channel (the green
 * of a green screen) and pull it down toward the strongest of the other two channels, by `spill`.
 * pixels whose dominant channel is not above the others (skin, white, black) do not change.
 */
export function despill(rgb: Rgb, key: ChromaKey): Rgb {
  const k = keyRgb(key);
  const m = k ? despillMask(k) : null;
  if (!m) return [rgb[0], rgb[1], rgb[2]];
  const dom = rgb[0] * m[0] + rgb[1] * m[1] + rgb[2] * m[2];
  const oth = Math.max(rgb[0] * (1 - m[0]), rgb[1] * (1 - m[1]), rgb[2] * (1 - m[2]));
  const cut = Math.max(dom - oth, 0) * clamp01(num(key.spill));
  return [rgb[0] - m[0] * cut, rgb[1] - m[1] * cut, rgb[2] - m[2] * cut];
}

// ---------------------------------------------------------------------------------------------
// webgl2 runner, one per channel
// ---------------------------------------------------------------------------------------------

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

interface Looker {
  canvas: GLCanvas;
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  tex: WebGLTexture;
  loc: {
    tex: WebGLUniformLocation | null;
    adj: WebGLUniformLocation | null;
    hue: WebGLUniformLocation | null;
    keyOn: WebGLUniformLocation | null;
    keyCbCr: WebGLUniformLocation | null;
    key: WebGLUniformLocation | null;
    mask: WebGLUniformLocation | null;
  };
  dead: boolean;
}

const lookers = new Map<string, Looker>();

/** how many looks have a live gl context (for tests) */
export function clipLookCount(): number {
  return lookers.size;
}
/** channels where webgl2 or the program is unusable: do not retry every frame */
const failed = new Set<string>();

function makeCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(2, 2);
  if (typeof document !== 'undefined') return createCanvas();
  return null;
}

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function createLooker(): Looker | null {
  const canvas = makeCanvas();
  if (!canvas) return null;
  // premultiplied alpha output; preserveDrawingBuffer so a caller may keep drawing from the canvas
  const gl = canvas.getContext('webgl2', {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    depth: false,
    stencil: false,
    preserveDrawingBuffer: true,
    powerPreference: 'high-performance',
  }) as WebGL2RenderingContext | null;
  if (!gl) return null;
  const vs = compile(gl, gl.VERTEX_SHADER, VERTEX_SRC);
  const fs = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SRC);
  const program = gl.createProgram();
  const tex = gl.createTexture();
  if (!vs || !fs || !program || !tex) return null;
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);
  // straight (un-premultiplied) color into the shader, row 0 = top of the picture
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  const looker: Looker = {
    canvas,
    gl,
    program,
    tex,
    loc: {
      tex: gl.getUniformLocation(program, 'u_tex'),
      adj: gl.getUniformLocation(program, 'u_adj'),
      hue: gl.getUniformLocation(program, 'u_hue'),
      keyOn: gl.getUniformLocation(program, 'u_keyOn'),
      keyCbCr: gl.getUniformLocation(program, 'u_keyCbCr'),
      key: gl.getUniformLocation(program, 'u_key'),
      mask: gl.getUniformLocation(program, 'u_mask'),
    },
    dead: false,
  };
  canvas.addEventListener('webglcontextlost', (e) => {
    e.preventDefault();
    looker.dead = true;
  });
  return looker;
}

function getLooker(channel: string): Looker | null {
  const cur = lookers.get(channel);
  if (cur && !cur.dead && !cur.gl.isContextLost()) return cur;
  if (cur) lookers.delete(channel); // lost: build a fresh one
  if (failed.has(channel)) return null;
  let made: Looker | null = null;
  try {
    made = createLooker();
  } catch {
    made = null;
  }
  if (!made) {
    failed.add(channel);
    return null;
  }
  lookers.set(channel, made);
  return made;
}

/** free the channel's gpu resources (call when an export is done; releaseRenderResources does). a later call rebuilds them. */
export function releaseClipLook(channel: 'preview' | 'export'): void {
  failed.delete(channel);
  const l = lookers.get(channel);
  if (!l) return;
  lookers.delete(channel);
  try {
    const gl = l.gl;
    gl.deleteTexture(l.tex);
    gl.deleteProgram(l.program);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    // give the drawing buffer back too
    l.canvas.width = 1;
    l.canvas.height = 1;
  } catch {
    // already gone
  }
}

/** the size clipLookTexture renders at: at least 1, larger side capped at 4096 */
export function lookSize(width: number, height: number): { w: number; h: number } | null {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
  const k = Math.min(1, MAX_SIDE / Math.max(width, height));
  return { w: Math.max(1, Math.round(width * k)), h: Math.max(1, Math.round(height * k)) };
}

/**
 * the clip's picture with its look applied. `source` is the untouched picture, width x height its
 * size in pixels. returns `source` itself when the clip has no look or webgl2 is missing.
 * the result is only valid until the next call on the same channel (it reuses one canvas).
 */
export function clipLookTexture(
  source: CanvasImageSource,
  width: number,
  height: number,
  clip: VisualClip,
  channel: 'preview' | 'export' = 'preview',
): CanvasImageSource {
  try {
    const size = lookSize(width, height);
    if (!size || !hasClipLook(clip)) return source;
    const l = getLooker(channel);
    if (!l) return source;
    const { gl, canvas } = l;
    if (canvas.width !== size.w || canvas.height !== size.h) {
      canvas.width = size.w;
      canvas.height = size.h;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, l.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source as TexImageSource);
    if (gl.isContextLost()) return source;
    gl.viewport(0, 0, size.w, size.h);
    gl.useProgram(l.program);
    gl.uniform1i(l.loc.tex, 0);

    const a = clip.adjust;
    const act = isAdjustActive(a);
    gl.uniform4f(
      l.loc.adj,
      act ? clamp(num(a!.brightness), -1, 1) : 0,
      act ? clamp(num(a!.contrast), -1, 1) : 0,
      act ? clamp(num(a!.saturation), -1, 1) : 0,
      act ? clamp(num(a!.temperature), -1, 1) : 0,
    );
    const rad = act ? (num(a!.hue) * Math.PI) / 180 : 0;
    gl.uniform2f(l.loc.hue, Math.cos(rad), Math.sin(rad));

    const key = clip.chromaKey;
    const kc = keyRgb(key);
    if (key && kc) {
      const cc = chromaOf(kc[0], kc[1], kc[2]);
      const m = despillMask(kc) ?? NO_MASK;
      gl.uniform1f(l.loc.keyOn, 1);
      gl.uniform2f(l.loc.keyCbCr, cc[0], cc[1]);
      gl.uniform3f(l.loc.key, num(key.tolerance), num(key.softness), clamp01(num(key.spill)));
      gl.uniform3f(l.loc.mask, m[0], m[1], m[2]);
    } else {
      gl.uniform1f(l.loc.keyOn, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return canvas;
  } catch {
    return source;
  }
}
