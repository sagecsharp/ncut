/**
 * runs effect passes on the gpu. one webgl2 context per channel (preview, export, thumbnails),
 * programs compiled lazily and cached, passes chained through two framebuffers.
 */
import { MAIN, PRELUDE, VERTEX_SRC } from './glsl';
import type { EffectDef, EffectPass } from './types';

type GLCanvas = OffscreenCanvas | HTMLCanvasElement;

interface Program {
  program: WebGLProgram;
  uniforms: Map<string, WebGLUniformLocation | null>;
}

export interface RenderEffectsOptions {
  /** project size in project pixels (u_size). defaults to the render size. */
  projectWidth?: number;
  projectHeight?: number;
  /** which gpu context to use. things that render at the same time must not share one. */
  channel?: string;
}

const KEY_RE = /^[a-z][a-zA-Z0-9]*$/;

export function fragmentSource(def: EffectDef): string {
  let uniforms = '';
  for (const p of def.params) {
    if (!KEY_RE.test(p.key)) throw new Error(`effect ${def.id}: bad param key "${p.key}"`);
    uniforms += `uniform float p_${p.key};\n`;
  }
  return `${PRELUDE}\n${uniforms}\n${def.glsl}\n${MAIN}`;
}

function makeCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(2, 2);
  if (typeof document !== 'undefined') return document.createElement('canvas');
  return null;
}

class Runner {
  readonly canvas: GLCanvas;
  private gl: WebGL2RenderingContext;
  private programs = new Map<string, Program | null>();
  private errors = new Map<string, string>();
  private vao: WebGLVertexArrayObject | null;
  private srcTex: WebGLTexture;
  private targets: { fbo: WebGLFramebuffer; tex: WebGLTexture }[] = [];
  private targetW = 0;
  private targetH = 0;
  dead = false;

  constructor(canvas: GLCanvas, gl: WebGL2RenderingContext) {
    this.canvas = canvas;
    this.gl = gl;
    this.vao = gl.createVertexArray();
    this.srcTex = this.makeTexture();
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
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

  private ensureTargets(w: number, h: number): void {
    const gl = this.gl;
    if (this.targets.length === 2 && this.targetW === w && this.targetH === h) return;
    for (const t of this.targets) {
      gl.deleteFramebuffer(t.fbo);
      gl.deleteTexture(t.tex);
    }
    this.targets = [];
    for (let i = 0; i < 2; i++) {
      const tex = this.makeTexture();
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      this.targets.push({ fbo, tex });
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.targetW = w;
    this.targetH = h;
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

  /** compiled program for an effect, or null when its shader is broken (logged once) */
  program(def: EffectDef): Program | null {
    const cached = this.programs.get(def.id);
    if (cached !== undefined) return cached;
    const gl = this.gl;
    let result: Program | null = null;
    let error = '';
    try {
      const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SRC);
      const fs = typeof vs === 'string' ? vs : this.compile(gl.FRAGMENT_SHADER, fragmentSource(def));
      if (typeof vs === 'string') error = vs;
      else if (typeof fs === 'string') {
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
        } else {
          result = { program, uniforms: new Map() };
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }
    if (!result && !this.dead) {
      this.errors.set(def.id, error);
      console.error(`[ncut] effect "${def.id}" failed to compile:\n${error}`);
    }
    this.programs.set(def.id, result);
    return result;
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

  render(source: TexImageSource, w: number, h: number, passes: EffectPass[], sizeW: number, sizeH: number): GLCanvas | null {
    const gl = this.gl;
    const ready: { pass: EffectPass; prog: Program }[] = [];
    for (const pass of passes) {
      if (!(pass.amount > 0)) continue;
      const prog = this.program(pass.def);
      if (prog) ready.push({ pass, prog });
    }
    if (ready.length === 0 || this.dead || gl.isContextLost()) return null;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (ready.length > 1) this.ensureTargets(w, h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return null;
    }
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);

    let input: WebGLTexture = this.srcTex;
    for (let i = 0; i < ready.length; i++) {
      const { pass, prog } = ready[i]!;
      const last = i === ready.length - 1;
      const target = last ? null : this.targets[i % 2]!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
      gl.useProgram(prog.program);
      gl.bindTexture(gl.TEXTURE_2D, input);
      gl.uniform1i(this.loc(prog, 'u_tex'), 0);
      // into a texture: row 0 = top of the picture. onto the canvas: flip so the top is up.
      gl.uniform1f(this.loc(prog, 'u_flip'), last ? -1 : 1);
      gl.uniform2f(this.loc(prog, 'u_res'), w, h);
      gl.uniform2f(this.loc(prog, 'u_size'), sizeW, sizeH);
      gl.uniform1f(this.loc(prog, 'u_time'), pass.time);
      gl.uniform1f(this.loc(prog, 'u_duration'), pass.duration);
      gl.uniform1f(this.loc(prog, 'u_amount'), Math.min(1, Math.max(0, pass.amount)));
      gl.uniform1f(this.loc(prog, 'u_seed'), pass.seed);
      for (const p of pass.def.params) {
        const v = pass.params[p.key];
        gl.uniform1f(this.loc(prog, `p_${p.key}`), typeof v === 'number' && Number.isFinite(v) ? v : p.default);
      }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      if (target) input = target.tex;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.canvas;
  }
}

const runners = new Map<string, Runner | null>();
let warned = false;

function getRunner(channel: string): Runner | null {
  const cur = runners.get(channel);
  if (cur && !cur.dead) return cur;
  if (cur === null) return null; // webgl2 is not available, do not retry every frame
  const canvas = makeCanvas();
  const gl = canvas
    ? (canvas.getContext('webgl2', {
        alpha: false,
        antialias: false,
        depth: false,
        stencil: false,
        preserveDrawingBuffer: false,
        powerPreference: 'high-performance',
      }) as WebGL2RenderingContext | null)
    : null;
  if (!canvas || !gl) {
    if (!warned && typeof document !== 'undefined') {
      warned = true;
      console.warn('[ncut] webgl2 is not available, effects are skipped');
    }
    runners.set(channel, null);
    return null;
  }
  const runner = new Runner(canvas, gl);
  runners.set(channel, runner);
  return runner;
}

/** false when the browser cannot run effects at all */
export function effectsSupported(): boolean {
  return getRunner('default') !== null;
}

/**
 * run the passes over `source` (anything webgl can upload: canvas, video, image, bitmap) and return
 * a canvas holding the result at width x height, or null when nothing ran (no passes, amount 0,
 * broken shader, no webgl2). the returned canvas is reused by the next call on the same channel:
 * draw it somewhere right away.
 */
export function renderEffects(
  source: TexImageSource,
  width: number,
  height: number,
  passes: EffectPass[],
  opts: RenderEffectsOptions = {},
): GLCanvas | null {
  if (passes.length === 0 || width < 1 || height < 1) return null;
  const runner = getRunner(opts.channel ?? 'default');
  if (!runner) return null;
  return runner.render(source, width, height, passes, opts.projectWidth ?? width, opts.projectHeight ?? height);
}

/** compile every effect and report the broken ones. for tests in the browser console. */
export function checkEffects(defs: EffectDef[]): { id: string; error: string }[] {
  const runner = getRunner('default');
  if (!runner) return [{ id: '*', error: 'webgl2 is not available' }];
  const out: { id: string; error: string }[] = [];
  for (const def of defs) {
    if (!runner.program(def)) out.push({ id: def.id, error: runner.errorOf(def.id) ?? 'unknown error' });
  }
  return out;
}
