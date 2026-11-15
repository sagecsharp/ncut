/**
 * runs effect passes on the gpu. one webgl2 context per channel (preview, export, thumbnails),
 * programs compiled lazily and cached, passes chained through two framebuffers.
 */
import { ALPHA_BLOCK, CUT_BLOCK, MAIN, MAIN_ALPHA, MAIN_CUT, PLAIN_BLOCK, PRELUDE, VERTEX_SRC } from './glsl';
import type { EffectDef, EffectPass, EffectVariant } from './types';
import { createCanvas } from '../../lib/canvas';

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

const VARIANT_BLOCK: Record<EffectVariant, string> = { plain: PLAIN_BLOCK, alpha: ALPHA_BLOCK, cut: CUT_BLOCK };
const VARIANT_MAIN: Record<EffectVariant, string> = { plain: MAIN, alpha: MAIN_ALPHA, cut: MAIN_CUT };

export function fragmentSource(def: EffectDef, variant: EffectVariant = 'plain'): string {
  let uniforms = '';
  for (const p of def.params) {
    if (!KEY_RE.test(p.key)) throw new Error(`effect ${def.id}: bad param key "${p.key}"`);
    uniforms += `uniform float p_${p.key};\n`;
  }
  // the plain build of a keep effect is the old source, byte for byte
  if (variant === 'plain' && !def.alpha) return `${PRELUDE}\n${uniforms}\n${def.glsl}\n${MAIN}`;
  return `${PRELUDE}\n${VARIANT_BLOCK[variant]}\n${uniforms}\n${def.glsl}\n${VARIANT_MAIN[variant]}`;
}

function makeCanvas(): GLCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(2, 2);
  if (typeof document !== 'undefined') return createCanvas();
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

  /** compile + link a fragment shader with the shared vertex shader. a string is the error. */
  private build(fsSrc: string): Program | string {
    const gl = this.gl;
    try {
      const vs = this.compile(gl.VERTEX_SHADER, VERTEX_SRC);
      if (typeof vs === 'string') return vs;
      const fs = this.compile(gl.FRAGMENT_SHADER, fsSrc);
      if (typeof fs === 'string') {
        gl.deleteShader(vs);
        return fs;
      }
      const program = gl.createProgram();
      gl.attachShader(program, vs);
      gl.attachShader(program, fs);
      gl.linkProgram(program);
      gl.deleteShader(vs);
      gl.deleteShader(fs);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        const log = gl.getProgramInfoLog(program) || 'link failed';
        gl.deleteProgram(program);
        return log;
      }
      return { program, uniforms: new Map() };
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * compiled program for an effect build, or null when its shader is broken (logged once). the cache and error key is
   * the id for the plain build and 'id|variant' for the others.
   */
  program(def: EffectDef, variant: EffectVariant = 'plain'): Program | null {
    const key = variant === 'plain' ? def.id : `${def.id}|${variant}`;
    const cached = this.programs.get(key);
    if (cached !== undefined) return cached;
    let result: Program | null = null;
    let error = '';
    try {
      const built = this.build(fragmentSource(def, variant));
      if (typeof built === 'string') error = built;
      else result = built;
    } catch (e) {
      // fragmentSource throws on a bad param key
      error = e instanceof Error ? e.message : String(e);
    }
    if (!result && !this.dead) {
      this.errors.set(key, error);
      console.error(`[ncut] effect "${key}" failed to compile:
${error}`);
    }
    this.programs.set(key, result);
    return result;
  }

  /** free every gpu object and the drawing buffer. the runner is unusable afterwards. */
  dispose(): void {
    this.dead = true;
    try {
      const gl = this.gl;
      for (const p of this.programs.values()) if (p) gl.deleteProgram(p.program);
      this.programs.clear();
      for (const t of this.targets) {
        gl.deleteFramebuffer(t.fbo);
        gl.deleteTexture(t.tex);
      }
      this.targets = [];
      gl.deleteTexture(this.srcTex);
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

  /** draw one effect pass: `input` -> `target` (null = the canvas, flipped so the top is up). u_tex is unit 0. */
  private runPass(
    pass: EffectPass,
    prog: Program,
    input: WebGLTexture,
    target: { fbo: WebGLFramebuffer; tex: WebGLTexture } | null,
    w: number,
    h: number,
    sizeW: number,
    sizeH: number,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target ? target.fbo : null);
    gl.useProgram(prog.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, input);
    gl.uniform1i(this.loc(prog, 'u_tex'), 0);
    // into a texture: row 0 = top of the picture. onto the canvas: flip so the top is up.
    gl.uniform1f(this.loc(prog, 'u_flip'), target ? 1 : -1);
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
  }

  private readyPasses(passes: EffectPass[], variantOf: (def: EffectDef) => EffectVariant = () => 'plain'): { pass: EffectPass; prog: Program }[] {
    const ready: { pass: EffectPass; prog: Program }[] = [];
    for (const pass of passes) {
      if (!(pass.amount > 0)) continue;
      const prog = this.program(pass.def, variantOf(pass.def));
      if (prog) ready.push({ pass, prog });
    }
    return ready;
  }

  render(source: TexImageSource, w: number, h: number, passes: EffectPass[], sizeW: number, sizeH: number): GLCanvas | null {
    const gl = this.gl;
    const ready = this.readyPasses(passes);
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
      this.runPass(pass, prog, input, target, w, h, sizeW, sizeH);
      if (target) input = target.tex;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.canvas;
  }

  /**
   * the alpha path (see renderEffectsAlpha). needs a runner made with an alpha canvas. the source is uploaded
   * premultiplied, a pass with alpha runs its alpha build, one without its cut build. two targets, ping pong, the last
   * pass onto the canvas (premultiplied, with the alpha the passes made).
   */
  renderAlpha(source: TexImageSource, w: number, h: number, passes: EffectPass[], sizeW: number, sizeH: number): GLCanvas | null {
    const gl = this.gl;
    const ready = this.readyPasses(passes, (d) => (d.alpha ? 'alpha' : 'cut'));
    if (ready.length === 0 || this.dead || gl.isContextLost()) return null;
    // a broken alpha or cut build: the plain run takes the clip
    let live = 0;
    for (const p of passes) if (p.amount > 0) live++;
    if (ready.length !== live) return null;

    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    if (ready.length > 1) this.ensureTargets(w, h);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    } catch {
      return null;
    } finally {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    }
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, w, h);

    let input: WebGLTexture = this.srcTex;
    for (let i = 0; i < ready.length; i++) {
      const { pass, prog } = ready[i]!;
      const last = i === ready.length - 1;
      const target = last ? null : this.targets[i % 2]!;
      this.runPass(pass, prog, input, target, w, h, sizeW, sizeH);
      if (target) input = target.tex;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return this.canvas;
  }
}

const runners = new Map<string, Runner | null>();
let warned = false;

/** the key of the runner whose canvas keeps an alpha channel (the premultiplied path) */
const PREMUL_SUFFIX = '#pm';

function getRunner(channel: string, premul = false): Runner | null {
  const key = premul ? channel + PREMUL_SUFFIX : channel;
  const cur = runners.get(key);
  if (cur && !cur.dead) return cur;
  if (cur === null) return null; // webgl2 is not available, do not retry every frame
  const canvas = makeCanvas();
  const gl = canvas
    ? (canvas.getContext('webgl2', {
        alpha: premul,
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
    runners.set(key, null);
    return null;
  }
  const runner = new Runner(canvas, gl);
  runners.set(key, runner);
  return runner;
}

/**
 * free the gpu resources of a channel's effect runner (programs, textures, the drawing buffer) and forget it, so a
 * finished export does not keep a 4k context alive. the next renderEffects on the channel builds a fresh runner.
 */
export function releaseEffectRunner(channel: string): void {
  for (const key of [channel, channel + PREMUL_SUFFIX]) {
    const r = runners.get(key);
    runners.delete(key);
    r?.dispose();
  }
}

/** how many channels have a runner (for tests) */
export function effectRunnerCount(): number {
  return runners.size;
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

/**
 * renderEffects for a picture with transparency, when at least one pass has an alpha (EffectDef.alpha). the picture is
 * uploaded premultiplied. a pass with alpha runs its alpha build: tex() gives premultiplied colour and it returns
 * premultiplied colour with its own alpha (the outline moves, spreads or gets holes). a pass without runs its cut build:
 * it reads straight colour and its result is cut to the alpha the pixel has at that point. the canvas keeps the alpha
 * and is premultiplied, so it can be drawn straight over anything. null when nothing ran (no passes, amount 0, a pass
 * with no working build, no webgl2). the canvas is reused by the next call on the channel: draw it somewhere right away.
 */
export function renderEffectsAlpha(
  source: TexImageSource,
  width: number,
  height: number,
  passes: EffectPass[],
  opts: RenderEffectsOptions = {},
): GLCanvas | null {
  if (passes.length === 0 || width < 1 || height < 1) return null;
  const runner = getRunner(opts.channel ?? 'default', true);
  if (!runner) return null;
  return runner.renderAlpha(source, width, height, passes, opts.projectWidth ?? width, opts.projectHeight ?? height);
}

/**
 * compile every effect and report the broken ones. for tests in the browser console. it also compiles the alpha build
 * (effects with alpha) or the cut build (the rest, not temporal) on the alpha runner and reports 'id|variant'.
 */
export function checkEffects(defs: EffectDef[]): { id: string; error: string }[] {
  const runner = getRunner('default');
  if (!runner) return [{ id: '*', error: 'webgl2 is not available' }];
  const out: { id: string; error: string }[] = [];
  for (const def of defs) {
    if (!runner.program(def)) out.push({ id: def.id, error: runner.errorOf(def.id) ?? 'unknown error' });
  }
  const pm = getRunner('default', true);
  if (pm) {
    for (const def of defs) {
      if (def.temporal) continue;
      const variant: EffectVariant = def.alpha ? 'alpha' : 'cut';
      if (pm.program(def, variant)) continue;
      const id = `${def.id}|${variant}`;
      out.push({ id, error: pm.errorOf(id) ?? 'unknown error' });
    }
  }
  return out;
}
