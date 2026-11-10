/**
 * a decoded video frame as a small picture (filmstrip pictures, posters), shrunk by the gpu.
 *
 * shrinking a 4k frame to a strip picture through a 2d canvas costs about 50 ms, five times the decode: so that
 * it does not shimmer the frame is first drawn at the target size times a power of two and then halved step by
 * step, and each step moves megabytes through the cpu. here the same steps run on the gpu in about 3 ms: the
 * frame is drawn into a texture of that bigger size, the mipmap chain of that texture is exactly those halvings
 * (2 x 2 averages), and the level with the target size is copied out. the turn and the mirror flag of the file
 * are applied in the first step, so the result is what the file's own canvas drawing gives.
 */

export type Quarter = 0 | 90 | 180 | 270;

/**
 * the size of the shrunk picture: the frame as it is shown (turned by `rotation`), scaled to the given width or
 * height, the other side from the aspect ratio. the same rounding as mediabunny's CanvasSink.
 */
export function shrunkSize(
  squareWidth: number,
  squareHeight: number,
  rotation: number,
  want: { width?: number; height?: number },
): { width: number; height: number } {
  const turned = rotation % 180 !== 0;
  const w = turned ? squareHeight : squareWidth;
  const h = turned ? squareWidth : squareHeight;
  const aspect = w > 0 && h > 0 ? w / h : 16 / 9;
  if (want.width !== undefined && want.height === undefined) {
    return { width: Math.max(1, Math.round(want.width)), height: Math.max(1, Math.round(want.width / aspect)) };
  }
  if (want.height !== undefined && want.width === undefined) {
    return { width: Math.max(1, Math.round(want.height * aspect)), height: Math.max(1, Math.round(want.height)) };
  }
  if (want.width !== undefined && want.height !== undefined) {
    return { width: Math.max(1, Math.round(want.width)), height: Math.max(1, Math.round(want.height)) };
  }
  return { width: Math.max(1, Math.round(w)), height: Math.max(1, Math.round(h)) };
}

/**
 * how many times the picture is halved on the way down: the frame (as shown, `sourceWidth` x `sourceHeight`) is
 * first drawn at the target size times 2^n, which is the biggest such size that is still smaller than the frame.
 * 0 when the target is at least half the frame (one bilinear step does not skip pixels then). `maxSide` keeps the
 * first step inside what the gpu takes as a texture. the same rule as mediabunny's canvas drawing.
 */
export function halvings(sourceWidth: number, sourceHeight: number, width: number, height: number, maxSide = 8192): number {
  if (!(sourceWidth > 0) || !(sourceHeight > 0) || !(width > 0) || !(height > 0)) return 0;
  let n = 0;
  if (2 * width < sourceWidth && 2 * height < sourceHeight) {
    n = Math.floor(Math.log2(Math.min(sourceWidth / width, sourceHeight / height)));
  }
  while (n > 0 && Math.max(width, height) * 2 ** n > maxSide) n--;
  return Math.max(0, n);
}

/**
 * where a point of the picture comes from in the stored frame. both in 0..1, x to the right, y down. the stored
 * frame is turned clockwise by `rotation` and then mirrored left to right when `flip` is set, this undoes both.
 * returned as [ux, uy, u0, vx, vy, v0] with u = ux * x + uy * y + u0 and v = vx * x + vy * y + v0.
 */
export function sourceOf(rotation: number, flip: boolean): [number, number, number, number, number, number] {
  // the mirror comes last, so it is undone first: x -> 1 - x
  const sx = flip ? -1 : 1;
  const x0 = flip ? 1 : 0;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      // u = y, v = 1 - x
      return [0, 1, 0, -sx, 0, 1 - x0];
    case 180:
      // u = 1 - x, v = 1 - y
      return [-sx, 0, 1 - x0, 0, -1, 1];
    case 270:
      // u = 1 - y, v = x
      return [0, -1, 1, sx, 0, x0];
    default:
      return [sx, 0, x0, 0, 1, 0];
  }
}

export interface FrameShrinker {
  readonly width: number;
  readonly height: number;
  /**
   * the frame as a picture of that size on a canvas that is reused by the next call: copy it before the next one
   * (createImageBitmap, toBlob). null when the gpu could not do it (lost context), the caller takes the slow way.
   */
  draw(frame: VideoFrame): HTMLCanvasElement | OffscreenCanvas | null;
  dispose(): void;
}

type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

function makeCanvas(width: number, height: number): AnyCanvas | null {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
  if (typeof document !== 'undefined') {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    return c;
  }
  return null;
}

const VERTEX = `#version 300 es
uniform vec3 uRowU;
uniform vec3 uRowV;
out vec2 vUv;
void main() {
  // one triangle over the whole target. p: 0..2, picture space with y down
  vec2 p = vec2(float(gl_VertexID & 1) * 2.0, float(gl_VertexID >> 1) * 2.0);
  vUv = vec2(dot(uRowU, vec3(p, 1.0)), dot(uRowV, vec3(p, 1.0)));
  gl_Position = vec4(p.x * 2.0 - 1.0, 1.0 - p.y * 2.0, 0.0, 1.0);
}`;

/** the frame, turned and mirrored as the file says, onto the target of this pass */
const FRAGMENT_FRAME = `#version 300 es
precision highp float;
uniform sampler2D uFrame;
in vec2 vUv;
out vec4 outColor;
void main() {
  outColor = vec4(texture(uFrame, vUv).rgb, 1.0);
}`;

/** one level of the mipmap chain, pixel for pixel */
const FRAGMENT_LEVEL = `#version 300 es
precision highp float;
uniform sampler2D uBig;
uniform int uLevel;
out vec4 outColor;
void main() {
  outColor = vec4(texelFetch(uBig, ivec2(gl_FragCoord.xy), uLevel).rgb, 1.0);
}`;

/**
 * a shrinker for frames of one file. null when webgl 2 is not there: the caller takes the slow way.
 * `rotation` and `flip` are what the file says about its picture.
 */
export function createShrinker(width: number, height: number, rotation: number, flip: boolean): FrameShrinker | null {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const glCanvas = makeCanvas(w, h);
  const outCanvas = makeCanvas(w, h);
  if (!glCanvas || !outCanvas) return null;
  let gl: WebGL2RenderingContext | null = null;
  let out: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  try {
    gl = glCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      preserveDrawingBuffer: false,
    }) as WebGL2RenderingContext | null;
    out = outCanvas.getContext('2d', { alpha: false }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
  } catch {
    gl = null;
  }
  if (!gl || !out) return null;
  const g = gl;
  const target = out;

  const shaders: WebGLShader[] = [];
  const build = (fragment: string): WebGLProgram | null => {
    const program = g.createProgram();
    if (!program) return null;
    for (const [type, source] of [
      [g.VERTEX_SHADER, VERTEX],
      [g.FRAGMENT_SHADER, fragment],
    ] as const) {
      const sh = g.createShader(type);
      if (!sh) return null;
      shaders.push(sh);
      g.shaderSource(sh, source);
      g.compileShader(sh);
      g.attachShader(program, sh);
    }
    g.linkProgram(program);
    return g.getProgramParameter(program, g.LINK_STATUS) ? program : null;
  };
  const frameProgram = build(FRAGMENT_FRAME);
  const levelProgram = build(FRAGMENT_LEVEL);
  const frameTexture = g.createTexture();
  const bigTexture = g.createTexture();
  const fbo = g.createFramebuffer();
  let lost = false;
  const release = () => {
    if (lost) return;
    lost = true;
    g.deleteTexture(frameTexture);
    g.deleteTexture(bigTexture);
    g.deleteFramebuffer(fbo);
    g.deleteProgram(frameProgram);
    g.deleteProgram(levelProgram);
    for (const sh of shaders) g.deleteShader(sh);
    g.getExtension('WEBGL_lose_context')?.loseContext();
  };
  if (!frameProgram || !levelProgram || !frameTexture || !bigTexture || !fbo) {
    release();
    return null;
  }
  const m = sourceOf(rotation, flip);
  g.useProgram(frameProgram);
  g.uniform3f(g.getUniformLocation(frameProgram, 'uRowU'), m[0], m[1], m[2]);
  g.uniform3f(g.getUniformLocation(frameProgram, 'uRowV'), m[3], m[4], m[5]);
  g.uniform1i(g.getUniformLocation(frameProgram, 'uFrame'), 0);
  g.useProgram(levelProgram);
  g.uniform1i(g.getUniformLocation(levelProgram, 'uBig'), 1);
  const levelAt = g.getUniformLocation(levelProgram, 'uLevel');
  // unit 0: the frame, read with plain bilinear filtering (the first step shrinks by less than 2)
  g.activeTexture(g.TEXTURE0);
  g.bindTexture(g.TEXTURE_2D, frameTexture);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.LINEAR);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  // unit 1: the big first step and its halvings
  g.activeTexture(g.TEXTURE1);
  g.bindTexture(g.TEXTURE_2D, bigTexture);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MIN_FILTER, g.NEAREST_MIPMAP_NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_MAG_FILTER, g.NEAREST);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_S, g.CLAMP_TO_EDGE);
  g.texParameteri(g.TEXTURE_2D, g.TEXTURE_WRAP_T, g.CLAMP_TO_EDGE);
  // a frame with transparency ends up over black, like on the opaque canvas this replaces
  g.pixelStorei(g.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
  g.disable(g.BLEND);
  g.disable(g.DEPTH_TEST);
  const maxSide = Math.min(8192, (g.getParameter(g.MAX_TEXTURE_SIZE) as number) || 4096);
  const turned = rotation % 180 !== 0;
  /** the levels the big texture was made for (-1 = not made yet) */
  let bigLevels = -1;

  return {
    width: w,
    height: h,
    draw(frame) {
      if (lost || g.isContextLost()) return null;
      try {
        const sw = turned ? frame.displayHeight : frame.displayWidth;
        const sh = turned ? frame.displayWidth : frame.displayHeight;
        const n = halvings(sw, sh, w, h, maxSide);
        g.activeTexture(g.TEXTURE0);
        g.texImage2D(g.TEXTURE_2D, 0, g.RGBA, g.RGBA, g.UNSIGNED_BYTE, frame);
        g.useProgram(frameProgram);
        if (n === 0) {
          // close enough to the frame's own size: one step, straight onto the canvas
          g.bindFramebuffer(g.FRAMEBUFFER, null);
          g.viewport(0, 0, w, h);
          g.drawArrays(g.TRIANGLES, 0, 3);
        } else {
          g.activeTexture(g.TEXTURE1);
          if (bigLevels !== n) {
            g.texImage2D(g.TEXTURE_2D, 0, g.RGBA8, w * 2 ** n, h * 2 ** n, 0, g.RGBA, g.UNSIGNED_BYTE, null);
            g.bindFramebuffer(g.FRAMEBUFFER, fbo);
            g.framebufferTexture2D(g.FRAMEBUFFER, g.COLOR_ATTACHMENT0, g.TEXTURE_2D, bigTexture, 0);
            if (g.checkFramebufferStatus(g.FRAMEBUFFER) !== g.FRAMEBUFFER_COMPLETE) return null;
            bigLevels = n;
          }
          g.bindFramebuffer(g.FRAMEBUFFER, fbo);
          g.viewport(0, 0, w * 2 ** n, h * 2 ** n);
          g.drawArrays(g.TRIANGLES, 0, 3);
          g.bindFramebuffer(g.FRAMEBUFFER, null);
          // every level is the 2 x 2 average of the one above: the halving steps
          g.generateMipmap(g.TEXTURE_2D);
          g.useProgram(levelProgram);
          g.uniform1i(levelAt, n);
          g.viewport(0, 0, w, h);
          g.drawArrays(g.TRIANGLES, 0, 3);
        }
        if (g.getError() !== g.NO_ERROR || g.isContextLost()) return null;
        // onto a plain canvas: the picture then lives in memory like before, not in the gpu process
        target.drawImage(glCanvas, 0, 0);
        return outCanvas;
      } catch {
        return null;
      }
    },
    dispose: release,
  };
}
