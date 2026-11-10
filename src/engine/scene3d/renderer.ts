/**
 * unlit 3d renderer: textured planes with a depth buffer, plus plain colored lines for editor helpers.
 * one webgl2 context per channel, like the effects runner. the result is a transparent canvas
 * (premultiplied alpha) that the 2d frame renderer draws on top of what is already there.
 */
import type { SceneFog, Shape3D } from '../../types';
import type { Mat4, Vec3 } from './math';
import { mul } from './math';
import { fogOn, writeFogUniforms } from './fog';
import { type FocusRig, MAX_BLUR, blurReach, boundFocus, meshNeedsBlur } from './focus';
import { interleave, knownShape, shapeMesh } from './meshes';
import { paintOrder } from './order';

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface Plane3D {
  image: TexImageSource;
  /**
   * set for pictures that do not change every frame (images, rendered text): the texture is uploaded
   * once per key and gets mipmaps. change the key when the pixels change. leave undefined for video.
   */
  cacheKey?: string;
  /** maps the unit shape (x, y, z in -0.5..0.5; a plane has z = 0) into world space */
  model: Mat4;
  /** missing or an id this build does not know = 'plane' (see meshes.ts) */
  shape?: Shape3D;
  /** 0..1 */
  alpha: number;
  /**
   * the part of the picture to show as [u0, v0, du, dv] (0..1 of the texture). missing = all of it.
   * the mesh uv 0..1 is remapped into this window.
   */
  uv?: [number, number, number, number];
  /**
   * rounded corners (plane only): radius in pixels of the plane, with the plane's own size in pixels.
   * the alpha is cut by a rounded rectangle with a ~1 screen pixel soft edge. missing / 0 = square.
   */
  radius?: number;
  size?: [number, number];
}

export interface Lines3D {
  /** x, y, z of each segment end, two points per segment */
  points: number[];
  /** straight rgba, 0..1 */
  color: [number, number, number, number];
}

const PLANE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
layout(location = 1) in vec2 a_uv;
uniform mat4 u_mvp;
// only read while fog is on (u_fogOn > 0): the world position of the vertex, for the distance to the eye
uniform mat4 u_model;
uniform float u_fogOn;
out vec2 v_uv;
out vec3 v_world;
// distance along the view direction (depth of field)
out float v_depth;
void main() {
  v_uv = a_uv;
  v_world = u_fogOn > 0.0 ? (u_model * vec4(a_pos, 1.0)).xyz : vec3(0.0);
  gl_Position = u_mvp * vec4(a_pos, 1.0);
  v_depth = gl_Position.w;
}`;
const PLANE_FS = `#version 300 es
precision highp float;
const float SOLID = 0.98;
in vec2 v_uv;
in vec3 v_world;
in float v_depth;
uniform sampler2D u_tex;
uniform float u_alpha;
uniform vec4 u_uv;
uniform float u_radius;
uniform vec2 u_size;
// 1 = only the solid pixels, 2 = only the see-through ones (see render)
uniform float u_pass;
// fog (fog.ts): rgb of the fog color, near / far - near / amount. u_fogOn = 0: off, nothing below runs.
uniform float u_fogOn;
uniform vec3 u_fogColor;
uniform vec3 u_fogRange;
uniform vec3 u_eye;
// depth of field (focus.ts focusBlur): u_focusOn = 0 for sharp meshes, nothing below runs for them.
// u_focus = distance, sharp range, reach, strength * MAX_BLUR. u_frameH = backing height in pixels.
// u_edge = 1: the mesh is a plane, its border fades by the blur radius.
uniform float u_focusOn;
uniform vec4 u_focus;
uniform float u_frameH;
uniform float u_edge;
out vec4 outColor;
// a vogel disc of taps (radius r in screen pixels), each read at the mip level that matches the tap spacing
vec4 discBlur(vec2 tc, vec2 dx, vec2 dy, float r) {
  float s = max(1.0, r * 0.6);
  vec2 gx = dx * s;
  vec2 gy = dy * s;
  vec2 lo = u_uv.xy;
  vec2 hi = u_uv.xy + u_uv.zw;
  vec4 sum = textureGrad(u_tex, tc, gx, gy);
  for (int i = 0; i < 12; i++) {
    float a = float(i) * 2.399963;
    float rad = r * sqrt((float(i) + 0.5) / 12.0);
    vec2 o = vec2(cos(a), sin(a)) * rad;
    sum += textureGrad(u_tex, clamp(tc + dx * o.x + dy * o.y, lo, hi), gx, gy);
  }
  return sum / 13.0;
}
void main() {
  vec2 tc = u_uv.xy + v_uv * u_uv.zw;
  vec4 c;
  // blur radius in screen pixels (0 = sharp)
  float blur = 0.0;
  if (u_focusOn > 0.0) {
    // derivatives first, outside any branch that depends on the pixel
    vec2 dx = dFdx(tc);
    vec2 dy = dFdy(tc);
    vec2 gu = vec2(length(vec2(dFdx(v_uv.x), dFdy(v_uv.x))), length(vec2(dFdx(v_uv.y), dFdy(v_uv.y))));
    float dz = max(abs(v_depth - u_focus.x) - u_focus.y, 0.0);
    blur = u_focus.w * u_frameH * dz / (dz + u_focus.z);
    if (blur > 0.25) {
      c = discBlur(tc, dx, dy, blur);
      if (u_edge > 0.5) {
        vec2 e = min(v_uv, 1.0 - v_uv) / max(gu, vec2(1e-6));
        float t = clamp(min(e.x, e.y) / (1.5 * blur), 0.0, 1.0);
        c *= t * t * (3.0 - 2.0 * t);
      }
    } else {
      blur = 0.0;
      c = texture(u_tex, tc);
    }
  } else {
    c = texture(u_tex, tc);
  }
  // the texture is premultiplied, so is the output
  c *= u_alpha;
  if (u_radius > 0.0) {
    // signed distance to a rounded rectangle, in plane pixels. the edge fades over about one screen pixel.
    vec2 q = abs((v_uv - 0.5) * u_size) - (u_size * 0.5 - vec2(u_radius));
    float d = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - u_radius;
    c *= clamp(0.5 - d / (max(fwidth(d), 1e-4) * (1.0 + blur)), 0.0, 1.0);
  }
  if (c.a < 0.004) discard;
  if (u_pass < 1.5 ? c.a < SOLID : c.a >= SOLID) discard;
  if (u_fogOn > 0.0) {
    // FOG MATH: must match fog.ts (fogFactor + mixFog). un-premultiply, mix, premultiply again; alpha is kept.
    float f = clamp((distance(v_world, u_eye) - u_fogRange.x) / u_fogRange.y, 0.0, 1.0) * u_fogRange.z;
    vec3 rgb = c.a > 0.0 ? c.rgb / c.a : vec3(0.0);
    c.rgb = mix(rgb, u_fogColor, f) * c.a;
  }
  outColor = c;
}`;
const LINE_VS = `#version 300 es
layout(location = 0) in vec3 a_pos;
uniform mat4 u_vp;
void main() {
  gl_Position = u_vp * vec4(a_pos, 1.0);
}`;
const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = vec4(u_color.rgb * u_color.a, u_color.a);
}`;

const CACHE_LIMIT = 48;

interface Mesh {
  vao: WebGLVertexArrayObject | null;
  count: number;
  buffers: (WebGLBuffer | null)[];
}

class SceneRenderer {
  readonly canvas: GLCanvas;
  private gl: WebGL2RenderingContext;
  private planeProg: WebGLProgram;
  private lineProg: WebGLProgram;
  private uMvp: WebGLUniformLocation | null;
  private uAlpha: WebGLUniformLocation | null;
  private uUv: WebGLUniformLocation | null;
  private uRadius: WebGLUniformLocation | null;
  private uSize: WebGLUniformLocation | null;
  private uPass: WebGLUniformLocation | null;
  private uModel: WebGLUniformLocation | null;
  private uFogOn: WebGLUniformLocation | null;
  private uFogColor: WebGLUniformLocation | null;
  private uFogRange: WebGLUniformLocation | null;
  private uEye: WebGLUniformLocation | null;
  private uFocusOn: WebGLUniformLocation | null;
  private uFocus: WebGLUniformLocation | null;
  private uFrameH: WebGLUniformLocation | null;
  private uEdge: WebGLUniformLocation | null;
  private fogBuf = new Float32Array(6);
  private uVp: WebGLUniformLocation | null;
  private uColor: WebGLUniformLocation | null;
  private meshes = new Map<Shape3D, Mesh>();
  private lineVao: WebGLVertexArrayObject | null;
  private lineBuf: WebGLBuffer | null;
  private cache = new Map<string, { tex: WebGLTexture; used: number }>();
  private scratch: WebGLTexture[] = [];
  /** scratch textures that currently have a mip filter (only while a mesh is blurred) */
  private scratchMips: boolean[] = [];
  private frame = 0;
  private aniso: { ext: EXT_texture_filter_anisotropic; max: number } | null = null;
  dead = false;

  constructor(canvas: GLCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.planeProg = this.link(PLANE_VS, PLANE_FS);
    this.lineProg = this.link(LINE_VS, LINE_FS);
    this.uMvp = gl.getUniformLocation(this.planeProg, 'u_mvp');
    this.uAlpha = gl.getUniformLocation(this.planeProg, 'u_alpha');
    this.uUv = gl.getUniformLocation(this.planeProg, 'u_uv');
    this.uRadius = gl.getUniformLocation(this.planeProg, 'u_radius');
    this.uSize = gl.getUniformLocation(this.planeProg, 'u_size');
    this.uPass = gl.getUniformLocation(this.planeProg, 'u_pass');
    this.uModel = gl.getUniformLocation(this.planeProg, 'u_model');
    this.uFogOn = gl.getUniformLocation(this.planeProg, 'u_fogOn');
    this.uFogColor = gl.getUniformLocation(this.planeProg, 'u_fogColor');
    this.uFogRange = gl.getUniformLocation(this.planeProg, 'u_fogRange');
    this.uEye = gl.getUniformLocation(this.planeProg, 'u_eye');
    this.uFocusOn = gl.getUniformLocation(this.planeProg, 'u_focusOn');
    this.uFocus = gl.getUniformLocation(this.planeProg, 'u_focus');
    this.uFrameH = gl.getUniformLocation(this.planeProg, 'u_frameH');
    this.uEdge = gl.getUniformLocation(this.planeProg, 'u_edge');
    this.uVp = gl.getUniformLocation(this.lineProg, 'u_vp');
    this.uColor = gl.getUniformLocation(this.lineProg, 'u_color');


    this.lineVao = gl.createVertexArray();
    gl.bindVertexArray(this.lineVao);
    this.lineBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    if (ext) this.aniso = { ext, max: Math.min(8, gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT) as number) };

    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dead = true;
    });
  }

  /** the context is gone (the event can come a moment after the loss, so ask the context too) */
  isLost(): boolean {
    return this.dead || this.gl.isContextLost();
  }

  /**
   * free every gpu object and the drawing buffer. the renderer is unusable afterwards (dead): drop it from the map so
   * the next use builds a fresh one.
   */
  dispose(): void {
    this.dead = true;
    try {
      const gl = this.gl;
      for (const e of this.cache.values()) gl.deleteTexture(e.tex);
      this.cache.clear();
      for (const t of this.scratch) if (t) gl.deleteTexture(t);
      this.scratch = [];
      for (const m of this.meshes.values()) {
        gl.deleteVertexArray(m.vao);
        for (const b of m.buffers) gl.deleteBuffer(b);
      }
      this.meshes.clear();
      gl.deleteVertexArray(this.lineVao);
      gl.deleteBuffer(this.lineBuf);
      gl.deleteProgram(this.planeProg);
      gl.deleteProgram(this.lineProg);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      // the antialiased depth + color buffer goes with a 1x1 canvas
      this.canvas.width = 1;
      this.canvas.height = 1;
    } catch {
      // already gone
    }
  }

  private link(vsSrc: string, fsSrc: string): WebGLProgram {
    const gl = this.gl;
    const make = (type: number, src: string) => {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src);
      gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader failed');
      return sh;
    };
    const p = gl.createProgram();
    gl.attachShader(p, make(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(p, make(gl.FRAGMENT_SHADER, fsSrc));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) || 'link failed');
    return p;
  }

  /** the gpu mesh for a shape, built on first use */
  private mesh(shape: Shape3D): Mesh {
    const hit = this.meshes.get(shape);
    if (hit) return hit;
    const gl = this.gl;
    const data = shapeMesh(shape);
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, interleave(data), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 20, 12);
    const ibo = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, data.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const mesh: Mesh = { vao, count: data.indices.length, buffers: [vbo, ibo] };
    this.meshes.set(shape, mesh);
    return mesh;
  }

  private newTexture(mips: boolean): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (mips && this.aniso) gl.texParameterf(gl.TEXTURE_2D, this.aniso.ext.TEXTURE_MAX_ANISOTROPY_EXT, this.aniso.max);
    return tex;
  }

  /** bind the texture for a plane, uploading when needed. false when the upload failed. */
  private bindPlaneTexture(plane: Plane3D, slot: number, mips = false): boolean {
    const gl = this.gl;
    if (plane.cacheKey !== undefined) {
      const hit = this.cache.get(plane.cacheKey);
      if (hit) {
        hit.used = this.frame;
        gl.bindTexture(gl.TEXTURE_2D, hit.tex);
        return true;
      }
      const tex = this.newTexture(true);
      try {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plane.image);
        gl.generateMipmap(gl.TEXTURE_2D);
      } catch {
        gl.deleteTexture(tex);
        return false;
      }
      this.cache.set(plane.cacheKey, { tex, used: this.frame });
      if (this.cache.size > CACHE_LIMIT) this.evict();
      return true;
    }
    let tex = this.scratch[slot];
    if (!tex) {
      tex = this.newTexture(false);
      this.scratch[slot] = tex;
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, plane.image);
      // a blurred video frame reads smaller mip levels: build them for this frame only
      if (mips !== (this.scratchMips[slot] === true)) {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
        this.scratchMips[slot] = mips;
      }
      if (mips) gl.generateMipmap(gl.TEXTURE_2D);
    } catch {
      return false;
    }
    return true;
  }

  private evict(): void {
    // drop the least recently used half
    const entries = [...this.cache.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < entries.length / 2; i++) {
      this.gl.deleteTexture(entries[i]![1].tex);
      this.cache.delete(entries[i]![0]);
    }
  }

  render(planes: Plane3D[], lines: Lines3D[], viewProj: Mat4, eye: Vec3, w: number, h: number, fog: SceneFog | null = null, focus: FocusRig | null = null): GLCanvas | null {
    const gl = this.gl;
    if (this.isLost()) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.frame++;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.CULL_FACE);

    // back to front (see order.ts), so see-through pixels blend over what is behind them.
    // each plane is drawn twice: its solid pixels write depth, which sorts out planes that cut
    // through each other; its see-through pixels (soft edges, shadows, fades) only test depth, so
    // they never punch a hole into a plane that is painted after them.
    const order = paintOrder(planes, viewProj, eye);

    gl.useProgram(this.planeProg);
    gl.activeTexture(gl.TEXTURE0);
    // fog: set once per render. off = one uniform at 0, the shader skips it.
    const fogging = fogOn(fog);
    writeFogUniforms(fog, this.fogBuf);
    gl.uniform1f(this.uFogOn, fogging ? 1 : 0);
    if (fogging) {
      gl.uniform3f(this.uFogColor, this.fogBuf[0]!, this.fogBuf[1]!, this.fogBuf[2]!);
      gl.uniform3f(this.uFogRange, this.fogBuf[3]!, this.fogBuf[4]!, this.fogBuf[5]!);
      gl.uniform3f(this.uEye, eye[0], eye[1], eye[2]);
    }
    // depth of field: set once per render. off = one uniform at 0 for every mesh.
    if (focus) {
      gl.uniform4f(this.uFocus, focus.distance, focus.range, blurReach(focus), focus.strength * MAX_BLUR);
      gl.uniform1f(this.uFrameH, h);
    } else gl.uniform1f(this.uFocusOn, 0);
    let slot = 0;
    // planes at the same depth (flat 3d layers stacked like 2d ones) must keep their layer order:
    // nudge each one toward the viewer by a few depth steps per layer
    gl.enable(gl.POLYGON_OFFSET_FILL);
    for (const index of order) {
      const plane = planes[index]!;
      if (!(plane.alpha > 0.001)) continue;
      gl.polygonOffset(0, -4 * index);
      const blurred = focus !== null && meshNeedsBlur(plane.model, viewProj, focus);
      if (!this.bindPlaneTexture(plane, slot, blurred)) continue;
      if (focus) {
        gl.uniform1f(this.uFocusOn, blurred ? 1 : 0);
        if (blurred) gl.uniform1f(this.uEdge, knownShape(plane.shape) === 'plane' ? 1 : 0);
      }
      if (plane.cacheKey === undefined) slot++;
      gl.uniformMatrix4fv(this.uMvp, false, mul(viewProj, plane.model));
      if (fogging) gl.uniformMatrix4fv(this.uModel, false, plane.model);
      gl.uniform1f(this.uAlpha, Math.min(1, plane.alpha));
      const uv = plane.uv;
      if (uv) gl.uniform4f(this.uUv, uv[0], uv[1], uv[2], uv[3]);
      else gl.uniform4f(this.uUv, 0, 0, 1, 1);
      const size = plane.size;
      if (plane.radius && plane.radius > 0 && size) {
        gl.uniform1f(this.uRadius, plane.radius);
        gl.uniform2f(this.uSize, size[0], size[1]);
      } else gl.uniform1f(this.uRadius, 0);
      const mesh = this.mesh(knownShape(plane.shape));
      gl.bindVertexArray(mesh.vao);
      // a plane that is faded as a whole has no solid pixels
      if (plane.alpha >= 0.98) {
        gl.depthMask(true);
        gl.uniform1f(this.uPass, 1);
        gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
      }
      gl.depthMask(false);
      gl.uniform1f(this.uPass, 2);
      gl.drawElements(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0);
    }
    gl.depthMask(true);
    gl.disable(gl.POLYGON_OFFSET_FILL);

    if (lines.length > 0) {
      gl.useProgram(this.lineProg);
      gl.bindVertexArray(this.lineVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
      gl.uniformMatrix4fv(this.uVp, false, viewProj);
      gl.depthMask(false);
      for (const l of lines) {
        if (l.points.length < 6) continue;
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(l.points), gl.DYNAMIC_DRAW);
        gl.uniform4f(this.uColor, l.color[0], l.color[1], l.color[2], l.color[3]);
        gl.drawArrays(gl.LINES, 0, l.points.length / 3);
      }
      gl.depthMask(true);
    }
    gl.bindVertexArray(null);
    return this.canvas;
  }
}

const renderers = new Map<string, SceneRenderer>();
/** channels whose renderer failed to start: not tried again before this time (ms) */
const retryAt = new Map<string, number>();
/** how long to wait before trying to start a renderer again after a failure (like the font retry in text.ts) */
export const SCENE_RETRY_MS = 2000;

/** true while a failed start of a channel must not be retried yet */
export function startBlocked(until: number | undefined, now: number): boolean {
  return until !== undefined && now < until;
}

function getRenderer(channel: string): SceneRenderer | null {
  const cur = renderers.get(channel);
  if (cur && !cur.isLost()) return cur;
  if (cur) {
    // lost: free what is left of it, a fresh one is built below
    renderers.delete(channel);
    cur.dispose();
  }
  // the pause is for the preview only: an export renders faster than real time, a wall clock pause would
  // drop the 3d clips from however many frames fit into it. it asks again on every frame instead.
  if (channel !== 'export' && startBlocked(retryAt.get(channel), Date.now())) return null;
  const fail = (): null => {
    retryAt.set(channel, Date.now() + SCENE_RETRY_MS);
    return null;
  };
  let canvas: GLCanvas | null = null;
  if (typeof OffscreenCanvas !== 'undefined') canvas = new OffscreenCanvas(2, 2);
  else if (typeof document !== 'undefined') canvas = document.createElement('canvas');
  const gl = canvas
    ? (canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: true,
        depth: true,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null)
    : null;
  if (!canvas || !gl) return fail();
  try {
    const r = new SceneRenderer(canvas, gl);
    renderers.set(channel, r);
    retryAt.delete(channel);
    return r;
  } catch (e) {
    console.error('[ncut] 3d renderer failed to start', e);
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // gone
    }
    return fail();
  }
}

/**
 * free the gpu resources of a channel's 3d renderer (textures, meshes, programs, the antialiased drawing buffer) and
 * forget it, plus any pending start retry. the next renderScene on the channel builds a fresh one.
 */
export function releaseSceneRenderer(channel: string): void {
  retryAt.delete(channel);
  const r = renderers.get(channel);
  if (!r) return;
  renderers.delete(channel);
  r.dispose();
}

/** how many channels have a renderer (for tests) */
export function sceneRendererCount(): number {
  return renderers.size;
}

/**
 * draw planes (and helper lines) through a camera. returns a transparent canvas of width x height
 * to composite right away (it is reused by the next call on the channel), or null without webgl2.
 */
export function renderScene(
  planes: Plane3D[],
  lines: Lines3D[],
  viewProj: Mat4,
  eye: Vec3,
  width: number,
  height: number,
  channel = 'default',
  /** distance haze over the planes (types.ts SceneFog). null = none. */
  fog: SceneFog | null = null,
  /** depth of field. undefined = the one the camera rig bound to viewProj (camera.ts); null = none */
  focus?: FocusRig | null,
): GLCanvas | null {
  if (width < 1 || height < 1 || (planes.length === 0 && lines.length === 0)) return null;
  let r = getRenderer(channel);
  if (!r) return null;
  const fo = focus === undefined ? boundFocus(viewProj) : focus;
  const out = r.render(planes, lines, viewProj, eye, width, height, fog, fo);
  if (out || !r.isLost()) return out;
  // the context was lost: try once more on a fresh renderer (getRenderer drops the lost one)
  r = getRenderer(channel);
  return r ? r.render(planes, lines, viewProj, eye, width, height, fog, fo) : null;
}
