/**
 * runs a transition on the gpu: two pictures in, one mixed picture out (premultiplied rgba, so clips
 * that do not fill the frame stay transparent around the edges). one webgl2 context per channel.
 */
import { PRELUDE, VERTEX_SRC } from '../effects/glsl';
import type { TransitionDef } from './registry';
import { createCanvas } from '../../lib/canvas';
import { textureHolds } from './sideMemo';

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

export interface TransitionRenderOptions {
  /** project size in project pixels (u_size) */
  projectWidth: number;
  projectHeight: number;
  /** which gl context to use. 'default' = preview, 'export' = export, 'thumb' = small ui previews. */
  channel?: 'default' | 'export' | 'thumb';
  /** varies the random parts */
  seed?: number;
  /**
   * what picture `a` / `b` are, when they are the same picture as the last call that gave the same key (a frozen side of
   * the transition): the texture that holds it is not uploaded again. the caller guarantees the same key = the same pixels.
   * undefined = upload every time.
   */
  keyA?: string;
  keyB?: string;
}

const HEAD = `
uniform sampler2D u_a;
uniform sampler2D u_b;
uniform float u_hasA;
uniform float u_hasB;
uniform float u_progress;

/** the outgoing picture, premultiplied. transparent outside the frame. */
vec4 a(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_a, uv) * u_hasA;
}
/** the incoming picture, premultiplied. transparent outside the frame. */
vec4 b(vec2 uv) {
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return vec4(0.0);
  return texture(u_b, uv) * u_hasB;
}
/** same pictures but the edge pixels repeat outside the frame (for zooms and spins) */
vec4 ac(vec2 uv) { return texture(u_a, clamp(uv, 0.0, 1.0)) * u_hasA; }
vec4 bc(vec2 uv) { return texture(u_b, clamp(uv, 0.0, 1.0)) * u_hasB; }
/** premultiplied "top over under" */
vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }
/** 0 at both ends, 1 in the middle */
float bump(float p) { return sin(PI * clamp(p, 0.0, 1.0)); }
/** soft threshold: 0 at p = 0 and 1 at p = 1 for every n in 0..1. e = softness. */
float reveal(float p, float n, float e) { return clamp((p * (1.0 + e) - n) / e, 0.0, 1.0); }
`;

const TAIL = `
void main() {
  outColor = clamp(transition(v_uv, clamp(u_progress, 0.0, 1.0)), 0.0, 1.0);
}`;

export function transitionFragmentSource(def: TransitionDef): string {
  return `${PRELUDE}\n${HEAD}\n${def.glsl}\n${TAIL}`;
}

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

function makeCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(2, 2);
  if (typeof document !== 'undefined') return createCanvas();
  return null;
}

class TransitionRunner {
  readonly canvas: GLCanvas;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program | null>();
  private errors = new Map<string, string>();
  private vao: WebGLVertexArrayObject | null;
  private texA: WebGLTexture;
  private texB: WebGLTexture;
  private empty: WebGLTexture;
  /** the key of the picture each texture holds (null = unknown: upload next time) */
  private keyA: string | null = null;
  private keyB: string | null = null;
  dead = false;

  constructor(canvas: GLCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.texA = this.makeTexture();
    this.texB = this.makeTexture();
    this.empty = this.makeTexture();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.dead = true;
    });
  }

  private makeTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  private compile(type: number, src: string): WebGLShader | string {
    const gl = this.gl;
    const sh = gl.createShader(type);
    if (!sh) return 'could not create shader';
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh) || 'compile failed';
      gl.deleteShader(sh);
      return log;
    }
    return sh;
  }

  program(def: TransitionDef): Program | null {
    const cached = this.programs.get(def.id);
    if (cached !== undefined) return cached;
    const gl = this.gl;
    let result: Program | null = null;
    let error = '';
    const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SRC);
    if (typeof vs === 'string') error = vs;
    else {
      const fs = this.compile(gl.FRAGMENT_SHADER, transitionFragmentSource(def));
      if (typeof fs === 'string') {
        error = fs;
        gl.deleteShader(vs);
      } else {
        const program = gl.createProgram();
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
          error = gl.getProgramInfoLog(program) || 'link failed';
          gl.deleteProgram(program);
        } else result = { program, uniforms: new Map() };
      }
    }
    if (!result && !this.dead) {
      this.errors.set(def.id, error);
      console.error(`[ncut] transition "${def.id}" failed to compile:\n${error}`);
    }
    this.programs.set(def.id, result);
    return result;
  }

  /** free every gpu object and the drawing buffer. the runner is unusable afterwards. */
  dispose(): void {
    this.dead = true;
    try {
      const gl = this.gl;
      for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program);
      this.programs.clear();
      gl.deleteTexture(this.texA);
      gl.deleteTexture(this.texB);
      gl.deleteTexture(this.empty);
      gl.deleteVertexArray(this.vao);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.canvas.width = 1;
      this.canvas.height = 1;
    } catch {
      // already gone
    }
  }

  errorOf(id: string): string | undefined {
    return this.errors.get(id);
  }

  private loc(p: Program, name: string): WebGLUniformLocation | null {
    let l = p.uniforms.get(name);
    if (l === undefined) {
      l = this.gl.getUniformLocation(p.program, name);
      p.uniforms.set(name, l);
    }
    return l;
  }

  /** upload a picture into a texture and bind it to a unit. `held` = the key the texture holds: with the same `key` the upload is skipped. returns whether there is a picture. */
  private upload(unit: number, tex: WebGLTexture, source: TexImageSource | null, held: string | null, key: string | undefined): { ok: boolean; held: string | null } {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    if (!source) {
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      return { ok: false, held: null };
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    // the texture still has this very picture (held is only set by a successful upload of a keyed picture)
    if (textureHolds(held, key)) return { ok: true, held };
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      return { ok: true, held: key ?? null };
    } catch {
      gl.bindTexture(gl.TEXTURE_2D, this.empty);
      return { ok: false, held: null };
    }
  }

  render(
    a: TexImageSource | null,
    b: TexImageSource | null,
    def: TransitionDef,
    progress: number,
    w: number,
    h: number,
    sizeW: number,
    sizeH: number,
    seed: number,
    keyA?: string,
    keyB?: string,
  ): GLCanvas | null {
    const gl = this.gl;
    if (this.dead || gl.isContextLost()) return null;
    const prog = this.program(def);
    if (!prog) return null;
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    gl.useProgram(prog.program);
    const ua = this.upload(1, this.texA, a, this.keyA, keyA);
    const ub = this.upload(2, this.texB, b, this.keyB, keyB);
    this.keyA = ua.held;
    this.keyB = ub.held;
    const hasA = ua.ok;
    const hasB = ub.ok;
    gl.uniform1i(this.loc(prog, 'u_a'), 1);
    gl.uniform1i(this.loc(prog, 'u_b'), 2);
    gl.uniform1f(this.loc(prog, 'u_hasA'), hasA ? 1 : 0);
    gl.uniform1f(this.loc(prog, 'u_hasB'), hasB ? 1 : 0);
    gl.uniform1f(this.loc(prog, 'u_progress'), progress);
    gl.uniform1f(this.loc(prog, 'u_flip'), -1);
    gl.uniform2f(this.loc(prog, 'u_res'), w, h);
    gl.uniform2f(this.loc(prog, 'u_size'), sizeW, sizeH);
    gl.uniform1f(this.loc(prog, 'u_time'), progress);
    gl.uniform1f(this.loc(prog, 'u_duration'), 1);
    gl.uniform1f(this.loc(prog, 'u_amount'), 1);
    gl.uniform1f(this.loc(prog, 'u_seed'), seed);
    gl.bindVertexArray(this.vao);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    return this.canvas;
  }
}

const runners = new Map<string, TransitionRunner | null>();

function getRunner(channel: string): TransitionRunner | null {
  const cur = runners.get(channel);
  if (cur && !cur.dead) return cur;
  if (cur === null) return null;
  const canvas = makeCanvas();
  const gl = canvas
    ? (canvas.getContext('webgl2', {
        alpha: true,
        premultipliedAlpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null)
    : null;
  if (!canvas || !gl) {
    runners.set(channel, null);
    return null;
  }
  const runner = new TransitionRunner(canvas, gl);
  runners.set(channel, runner);
  return runner;
}

/**
 * free the gpu resources of a channel's transition runner and forget it, so a finished export does not keep a 4k
 * context alive. the next renderTransition on the channel builds a fresh runner.
 */
export function releaseTransitionRunner(channel: string): void {
  const r = runners.get(channel);
  runners.delete(channel);
  r?.dispose();
}

/** how many channels have a runner (for tests) */
export function transitionRunnerCount(): number {
  return runners.size;
}

/**
 * mix picture `a` (outgoing, may be null = transparent) into picture `b` (incoming, may be null) at
 * progress 0..1. returns a canvas of width x height holding premultiplied rgba, valid until the next
 * call on the same channel (draw it somewhere right away). null when webgl2 is not available or the
 * shader is broken.
 */
export function renderTransition(
  a: TexImageSource | null,
  b: TexImageSource | null,
  def: TransitionDef,
  progress: number,
  width: number,
  height: number,
  opts: TransitionRenderOptions,
): HTMLCanvasElement | OffscreenCanvas | null {
  if (width < 1 || height < 1) return null;
  const runner = getRunner(opts.channel ?? 'default');
  if (!runner) return null;
  return runner.render(a, b, def, Math.min(1, Math.max(0, progress)), width, height, opts.projectWidth, opts.projectHeight, opts.seed ?? 0, opts.keyA, opts.keyB);
}

/** compile every transition and report the broken ones. for tests in the browser console. */
export function checkTransitions(defs: TransitionDef[]): { id: string; error: string }[] {
  const runner = getRunner('default');
  if (!runner) return [{ id: '*', error: 'webgl2 is not available' }];
  const out: { id: string; error: string }[] = [];
  for (const def of defs) {
    if (!runner.program(def)) out.push({ id: def.id, error: runner.errorOf(def.id) ?? 'unknown error' });
  }
  return out;
}

/** the progress curve every transition uses: slow start, slow end */
export function easeTransition(t: number): number {
  const x = Math.min(1, Math.max(0, t));
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
}
