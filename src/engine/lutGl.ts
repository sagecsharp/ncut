/**
 * the gpu side of a lut (see gradeLut.ts): the texture units of a lut program, the tables as textures and the six
 * uniforms. no program is built here. units: 0 the picture, 1 the curve table, 2 the 3d table, 3 the 1d table (two
 * sampler types on one unit are INVALID_OPERATION at draw, so every lut program sets all of them right after link).
 */
import type { LutTable } from '../lib/cube';
import { lutUniforms } from './gradeLut';
import type { LutBind } from './gradeLut';

/** the 1d table is rows of this many points */
const ROW = 256;
/** how many tables stay on the gpu */
const KEEP = 4;

let warned = false;

/** u_gCurves 1, u_gLut3 2, u_gLut1 3. call once right after link on every program that has a lut chunk */
export function setLutUnits(gl: WebGL2RenderingContext, program: WebGLProgram): void {
  gl.useProgram(program);
  gl.uniform1i(gl.getUniformLocation(program, 'u_gCurves'), 1);
  gl.uniform1i(gl.getUniformLocation(program, 'u_gLut3'), 2);
  gl.uniform1i(gl.getUniformLocation(program, 'u_gLut1'), 3);
}

/** the textures of one table. a part the table does not have is null. ok false = the gpu refused the upload */
interface Entry {
  table: LutTable;
  tex3: WebGLTexture | null;
  tex1: WebGLTexture | null;
  ok: boolean;
}

/** the lut tables of one gl context: made on first use, the four used last stay */
export class LutGpu {
  private readonly gl: WebGL2RenderingContext;
  private readonly entries = new Map<string, Entry>();
  private hole3: WebGLTexture | null = null;
  private hole1: WebGLTexture | null = null;

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
  }

  /** binds the table's textures on units 2 and 3 (uploads on first use, lru of 4), back on unit 0. false = the gpu refused it */
  bind(table: LutTable): boolean {
    const gl = this.gl;
    let e = this.entries.get(table.key);
    if (e && e.table !== table) {
      this.free(e);
      this.entries.delete(table.key);
      e = undefined;
    }
    if (e) {
      this.entries.delete(table.key);
      this.entries.set(table.key, e);
    } else {
      e = this.upload(table);
      this.entries.set(table.key, e);
      if (this.entries.size > KEEP) {
        const oldest = this.entries.keys().next().value!;
        this.free(this.entries.get(oldest)!);
        this.entries.delete(oldest);
      }
    }
    // no unit a lut program samples may be empty at a draw: a missing part gets a one texel hole
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_3D, e.ok && e.tex3 ? e.tex3 : this.placeholder3());
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, e.ok && e.tex1 ? e.tex1 : this.placeholder1());
    gl.activeTexture(gl.TEXTURE0);
    return e.ok;
  }

  dispose(): void {
    const gl = this.gl;
    try {
      for (const e of this.entries.values()) this.free(e);
      this.entries.clear();
      if (this.hole3) gl.deleteTexture(this.hole3);
      if (this.hole1) gl.deleteTexture(this.hole1);
    } catch {
      // already gone
    }
    this.hole3 = null;
    this.hole1 = null;
  }

  private free(e: Entry): void {
    if (e.tex3) this.gl.deleteTexture(e.tex3);
    if (e.tex1) this.gl.deleteTexture(e.tex1);
  }

  private nearest(target: number): void {
    const gl = this.gl;
    gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (target === gl.TEXTURE_3D) gl.texParameteri(target, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
  }

  /** a float view upload needs both flags off (lut 3.7): off around the call, put back after */
  private flat(run: () => void): void {
    const gl = this.gl;
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    const premul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    try {
      run();
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul);
    }
  }

  private placeholder3(): WebGLTexture | null {
    const gl = this.gl;
    if (!this.hole3) {
      this.hole3 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_3D, this.hole3);
      this.nearest(gl.TEXTURE_3D);
      this.flat(() => gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 1, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3)));
    }
    return this.hole3;
  }

  private placeholder1(): WebGLTexture | null {
    const gl = this.gl;
    if (!this.hole1) {
      this.hole1 = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.hole1);
      this.nearest(gl.TEXTURE_2D);
      this.flat(() => gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, 1, 1, 0, gl.RGB, gl.FLOAT, new Float32Array(3)));
    }
    return this.hole1;
  }

  /** the textures of a table. 32 bit floats do not filter, so nearest and the lerp is in the shader */
  private upload(table: LutTable): Entry {
    const gl = this.gl;
    const e: Entry = { table, tex3: null, tex1: null, ok: true };
    const flip = gl.getParameter(gl.UNPACK_FLIP_Y_WEBGL) as boolean;
    const premul = gl.getParameter(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL) as boolean;
    const align = gl.getParameter(gl.UNPACK_ALIGNMENT) as number;
    try {
      // older errors are not ours
      let drain = 8;
      while (drain-- > 0 && gl.getError() !== gl.NO_ERROR) continue;
      // texImage3D from a view with either flag on is INVALID_OPERATION
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      if (table.size3 > 0) {
        const n = table.size3;
        e.tex3 = gl.createTexture();
        gl.activeTexture(gl.TEXTURE2);
        gl.bindTexture(gl.TEXTURE_3D, e.tex3);
        this.nearest(gl.TEXTURE_3D);
        gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, table.data3);
      }
      if (table.size1 > 0) {
        const rows = Math.ceil(table.size1 / ROW);
        const padded = new Float32Array(ROW * rows * 3);
        padded.set(table.data1.subarray(0, table.size1 * 3));
        e.tex1 = gl.createTexture();
        gl.activeTexture(gl.TEXTURE3);
        gl.bindTexture(gl.TEXTURE_2D, e.tex1);
        this.nearest(gl.TEXTURE_2D);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, ROW, rows, 0, gl.RGB, gl.FLOAT, padded);
      }
      if (gl.getError() !== gl.NO_ERROR) e.ok = false;
    } catch {
      e.ok = false;
    } finally {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, flip);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premul);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, align);
      gl.activeTexture(gl.TEXTURE0);
    }
    if (!e.ok) {
      this.free(e);
      e.tex3 = null;
      e.tex1 = null;
      if (!warned) {
        warned = true;
        console.warn('the gpu could not take a lut, clips draw without it');
      }
    }
    return e;
  }
}

/** the six uniforms of a bind (lutUniforms). ok false: mix 0 and no table flags, the color passes through */
export function bindLutUniforms(gl: WebGL2RenderingContext, loc: (name: string) => WebGLUniformLocation | null, b: LutBind, ok: boolean): void {
  const u = lutUniforms(b);
  gl.uniform4f(loc('u_gLut'), ok ? u.lut[0] : 0, u.lut[1], u.lut[2], ok ? u.lut[3] : 0);
  gl.uniform4f(loc('u_gLutN'), u.n[0], u.n[1], ok ? u.n[2] : 0, u.n[3]);
  gl.uniform3f(loc('u_gLut3Min'), u.min3[0], u.min3[1], u.min3[2]);
  gl.uniform3f(loc('u_gLut3Span'), u.span3[0], u.span3[1], u.span3[2]);
  gl.uniform3f(loc('u_gLut1Min'), u.min1[0], u.min1[1], u.min1[2]);
  gl.uniform3f(loc('u_gLut1Span'), u.span1[0], u.span1[1], u.span1[2]);
}
