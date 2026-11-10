/**
 * pictures for a paused preview while the playhead is dragged through a video.
 *
 * a video element starts every seek at the key frame before the wanted time and decodes up to it: with a big file
 * that is 60 to 100 ms per picture, so a drag shows about 15 pictures a second. this feed is a decoder of its own
 * (the same one the export uses) that just keeps going while the playhead moves forward: the next picture is one
 * or a few frames of decoding away. the engine shows the feed's frame only while it is nearer to the wanted time
 * than what the element shows (scrubPlan.feedIsNearer), the element still lands on the exact frame when the drag
 * rests.
 *
 * moving backwards no decoder can just keep going: every picture lies before the last one. so the feed decodes the
 * stretch behind the playhead once (from the key frame before it) and keeps those frames, each on a canvas of its
 * own, as many as BACK_BYTES allows. the playhead then walks back through them, and when half of them are used up
 * the stretch before is decoded the same way. a drag that passes several frames per picture keeps only every
 * second, third ... frame, so the kept ones reach further. a drag too fast even for that gets the element alone,
 * and so does a file above 1440p: too few of its frames fit, and the element is as fast there.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';
import type { EncodedPacket, InputVideoTrack, WrappedCanvas } from 'mediabunny';
import type { DrawSource } from '../../engine/draw';
import {
  BACK_AFTER,
  BACK_MISSES,
  MAX_STARTS,
  backFrames,
  backStretch,
  backStride,
  coverIndex,
  feedIsNearer,
  feedStep,
  frameDistance,
  heldLength,
  movedBack,
  startsBy,
} from './scrubPlan';

/** the decoder is given back after this long without a new wanted time */
const REST_AFTER_MS = 3000;
/** frames on the way to the wanted time are shown at most this often */
const TELL_EVERY_MS = 12;
/** the longest stretch of decoding without letting the page handle input */
const SLICE_MS = 8;
/** after fills the playhead had left already, the feed stays out of a backward drag for this long */
const BACK_OFF_MS = 500;
/** times closer than this are the same time */
const EPS = 1e-4;

/** packets fed to the decoder past the end of a stretch (frames are stored in another order than they are shown) */
const REORDER_FRAMES = 6;

type Surface = HTMLCanvasElement | OffscreenCanvas;
/** what a frame of the feed is drawn from: a canvas of the forward decoder, or a kept frame */
type Picture = Surface | ImageBitmap;

interface Held {
  canvas: Picture;
  /** start of the frame and how long it stands, seconds */
  timestamp: number;
  duration: number;
}

/** one stretch that is decoded for a backward drag */
interface BackJob {
  from: number;
  end: number;
  stride: number;
  /** the next frame to keep starts at or after this */
  keepAt: number;
  /** the most frames kept, the ones nearest the end win */
  most: number;
  got: Held[];
  /** frames on their way to a bitmap */
  pending: Promise<void>[];
  /** not wanted any more: the decoder was emptied */
  dropped: boolean;
}

const pause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

export class ScrubFeed {
  private readonly blob: Blob;
  private readonly onFrame: () => void;
  private input: Input | null = null;
  private track: InputVideoTrack | null = null;
  /** made for a drag and dropped when it rests: its three canvases are as big as the video */
  private sink: CanvasSink | null = null;
  private readonly canvases = new Set<HTMLCanvasElement | OffscreenCanvas>();
  private packets: EncodedPacketSink | null = null;
  private gen: AsyncGenerator<WrappedCanvas, void, unknown> | null = null;
  private cur: Held | null = null;
  /** the frame after `cur`, decoded already: the wanted time lies before it (in `cur`, or in a gap after it) */
  private ahead: Held | null = null;
  /** start of the last frame of the file, once the decoder ran into the end */
  private fileEnd: number | null = null;
  /** new starts made for one wanted time (see MAX_STARTS) */
  private starts = 0;
  private startsFor: number | null = null;
  private source: DrawSource | null = null;
  private target: number | null = null;
  private lastWant: number | null = null;
  private backward = false;
  private running = false;
  /** new: not opened yet, ready: can decode, off: this file is not for the feed (the element does it alone) */
  private state: 'new' | 'ready' | 'off' = 'new';
  private disposed = false;
  private resting = false;
  private lastTell = 0;
  /** the engine was told about the frame held now */
  private told = true;
  private restTimer: ReturnType<typeof setTimeout> | null = null;
  /** frames behind the playhead for a backward drag, ascending, each a bitmap of its own (see the top) */
  private back: Held[] = [];
  /** every bitmap of a kept frame that is not closed yet */
  private readonly bitmaps = new Set<ImageBitmap>();
  /** canvases of the feed's own that hold nothing at the moment */
  private spare: Surface[] = [];
  /** every canvas of the feed's own (the others belong to the forward decoder) */
  private readonly own = new Set<Surface>();
  /** picture of a frame that is still shown but not among the kept ones any more */
  private lone: Picture | null = null;
  private capacity = 6;
  /** length of a frame of this file (seconds), from the last decoded one */
  private frameLen = 1 / 30;
  /** how fast the wanted time moves, seconds of the file per ms */
  private speed = 0;
  private lastMoveAt = 0;
  /** backward moves in a row */
  private backRun = 0;
  private misses = 0;
  private backOffUntil = 0;
  /** the kept frames start at the first frame of the file */
  private backFloor = false;
  /** how long the last fill took (ms) */
  private fillMs = 100;
  /** the stretch that is decoded right now for a backward drag */
  private filling: { from: number; end: number } | null = null;
  private job: BackJob | null = null;
  private decoder: VideoDecoder | null = null;
  private config: VideoDecoderConfig | null = null;
  /** this file gets no kept frames: a picture turned in the file, or a decoder that gave up */
  private backDead = false;

  constructor(blob: Blob, onFrame: () => void) {
    this.blob = blob;
    this.onFrame = onFrame;
  }

  /** the playhead wants the picture of this time (seconds into the file). only the newest one counts */
  want(time: number): void {
    if (this.disposed || this.state === 'off' || !Number.isFinite(time)) return;
    if (this.lastWant !== null && Math.abs(time - this.lastWant) > EPS) {
      const now = performance.now();
      const dt = now - this.lastMoveAt;
      if (dt >= 250) this.speed = 0;
      else if (dt > 0.5) this.speed = 0.6 * this.speed + 0.4 * ((time - this.lastWant) / dt);
      this.lastMoveAt = now;
      if (time < this.lastWant) this.backRun++;
      else {
        this.backRun = 0;
        this.misses = 0;
        this.backOffUntil = 0;
      }
    }
    this.backward = movedBack(this.lastWant, time, this.backward);
    if (this.job) {
      // a stretch is being decoded: the loop waits for it. the kept frames still give the picture, and a stretch
      // for a drag that turned around is not waited for
      if (!this.backward) this.dropFill();
      else {
        const i = coverIndex(this.back, time);
        if (i >= 0) this.show(i);
      }
    }
    this.lastWant = time;
    this.target = time;
    this.resting = false;
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = setTimeout(() => this.rest(), REST_AFTER_MS);
    void this.run();
  }

  /**
   * the feed's frame as a picture, when it is nearer to `target` than the frame the element shows (`shown`: start
   * time of that frame) and has the element's size. null: draw the element.
   */
  nearer(target: number, shown: number, width: number, height: number): DrawSource | null {
    const cur = this.cur;
    if (!cur || this.state !== 'ready' || this.disposed) return null;
    const canvas = cur.canvas;
    // another size than the element's picture (odd pixel shapes): the two would not line up. the feed can never
    // be drawn for this file, so it gets out of the element's way for good
    if (canvas.width !== width || canvas.height !== height) {
      if (width > 0 && height > 0) {
        if (this.mine(canvas)) {
          // only the kept frames of a backward drag come out in another size: those go
          this.backDead = true;
          this.cur = null;
          this.dropBack();
        } else {
          this.state = 'off';
          void this.run();
        }
      }
      return null;
    }
    const held = this.held();
    if (!held || !feedIsNearer(held, shown, target)) return null;
    if (!this.source || this.source.image !== canvas) this.source = { image: canvas, width, height };
    return this.source;
  }

  /**
   * is the feed on its way to this time (or there)? then the element does not have to chase the playhead: its seeks
   * would only take the decoder away from the feed. false while it opens, for a file it cannot do, and moving back
   * without a kept frame for the time.
   */
  leads(target: number): boolean {
    if (this.disposed || this.state !== 'ready' || this.target === null) return false;
    // the stretch that is decoded right now will hold this time
    const fill = this.filling;
    if (fill) return (target >= fill.from - EPS && target < fill.end) || feedStep(this.held(), false, target, true) === 'have';
    return feedStep(this.held(), this.gen !== null, target, this.backward) !== 'idle';
  }

  /** the frame the feed holds and the stretch of time it stands for */
  private held(): { start: number; length: number } | null {
    const cur = this.cur;
    if (!cur) return null;
    const last = this.fileEnd !== null && cur.timestamp >= this.fileEnd;
    return { start: cur.timestamp, length: heldLength(cur.timestamp, cur.duration, this.ahead ? this.ahead.timestamp : null, last) };
  }

  /** playback started or nothing moves any more: give the decoder back, the next drag opens it again */
  rest(): void {
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    if (this.disposed) return;
    this.target = null;
    this.lastWant = null;
    this.backward = false;
    this.backRun = 0;
    this.misses = 0;
    this.backOffUntil = 0;
    this.speed = 0;
    this.dropFill();
    // nothing open: nothing to give back
    if (!this.gen && !this.cur && !this.decoder && this.canvases.size === 0 && this.bitmaps.size === 0) return;
    this.resting = true;
    void this.run();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.restTimer !== null) clearTimeout(this.restTimer);
    this.restTimer = null;
    this.target = null;
    this.cur = null;
    this.ahead = null;
    this.source = null;
    this.dropFill();
    if (!this.running) void this.teardown();
  }

  private async open(): Promise<void> {
    const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(this.blob) });
    this.input = input;
    const track = await input.getPrimaryVideoTrack();
    // pictures the element may show differently stay with the element: see-through video, hdr, and files whose
    // first frame is not at 0 (the element's clock and the file's times then differ)
    if (!track || !(await track.canDecode()) || (await track.canBeTransparent()) || (await track.hasHighDynamicRange())) {
      this.state = 'off';
      return;
    }
    const first = await track.getFirstTimestamp();
    if (Math.abs(first) > 5e-4) {
      this.state = 'off';
      return;
    }
    this.track = track;
    this.packets = new EncodedPacketSink(track);
    this.capacity = backFrames(track.displayWidth, track.displayHeight);
    // the kept frames are drawn as they come out of the decoder: a picture the file turns stays with the element.
    // so does one too big to keep enough frames of
    if (track.rotation !== 0 || this.capacity === 0) this.backDead = true;
    this.state = 'ready';
  }

  /** start time of the key frame at or before a time, null when the file does not say */
  private async keyBefore(time: number): Promise<number | null> {
    try {
      const packet = await this.packets?.getKeyPacket(time, { metadataOnly: true });
      return packet && packet.timestamp <= time ? packet.timestamp : null;
    } catch {
      return null;
    }
  }

  private async closeGen(): Promise<void> {
    const gen = this.gen;
    this.gen = null;
    // the frame after the held one belongs to the decoder that is closed here
    this.ahead = null;
    if (!gen) return;
    try {
      await gen.return(undefined);
    } catch {
      // the decoder was already gone
    }
  }

  /** forget the frame and free the canvases the frames were drawn on (the decoder must be closed already) */
  private letGo(): void {
    this.cur = null;
    this.ahead = null;
    this.source = null;
    this.sink = null;
    this.back = [];
    this.spare = [];
    this.own.clear();
    this.lone = null;
    this.backFloor = false;
    this.dropDecoder();
    for (const bitmap of this.bitmaps) bitmap.close();
    this.bitmaps.clear();
    for (const canvas of this.canvases) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.canvases.clear();
  }

  private async teardown(): Promise<void> {
    await this.closeGen();
    this.letGo();
    this.track = null;
    this.packets = null;
    const input = this.input;
    this.input = null;
    try {
      input?.dispose();
    } catch {
      // already closed
    }
  }

  /** a copy of a frame of the forward decoder on a canvas of the feed's own (the decoder draws over its canvases) */
  private keep(frame: Held): Held | null {
    const from = frame.canvas;
    const canvas = this.blank(from.width, from.height);
    const ctx = canvas.getContext('2d') as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
    if (!ctx) {
      this.spare.push(canvas);
      return null;
    }
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(from, 0, 0);
    return { canvas, timestamp: frame.timestamp, duration: frame.duration };
  }

  /** is this picture one of the feed's own (not a canvas the forward decoder draws on)? */
  private mine(picture: Picture): boolean {
    return (typeof ImageBitmap !== 'undefined' && picture instanceof ImageBitmap) || this.own.has(picture as Surface);
  }

  /** a picture of the feed's own is not needed any more */
  private free(picture: Picture): void {
    if (typeof ImageBitmap !== 'undefined' && picture instanceof ImageBitmap) {
      this.bitmaps.delete(picture);
      picture.close();
    } else if (this.own.has(picture as Surface)) {
      this.spare.push(picture as Surface);
    }
  }

  /** every kept frame goes, but not the one that is shown */
  private dropBack(): void {
    const shown = this.cur?.canvas;
    for (const f of this.back) if (f.canvas !== shown) this.free(f.canvas);
    if (this.lone && this.lone !== shown) this.free(this.lone);
    this.back = [];
    this.lone = shown && this.mine(shown) ? shown : null;
    this.backFloor = false;
  }

  /** the kept frame `i` is the picture now */
  private show(i: number): void {
    const frame = this.back[i]!;
    if (this.cur === frame) return;
    if (this.lone && this.lone !== frame.canvas) this.free(this.lone);
    this.lone = null;
    this.cur = frame;
    this.ahead = null;
    this.told = true;
    this.lastTell = performance.now();
    this.onFrame();
  }

  /** a fill the playhead had left before it was done. too many in a row: the drag is too fast for the feed */
  private missed(): void {
    if (++this.misses < BACK_MISSES) return;
    this.misses = 0;
    this.backOffUntil = performance.now() + BACK_OFF_MS;
  }

  /**
   * the playhead moves backwards and the frame held is not the wanted one: the picture from the kept frames, and
   * more of them decoded before they run out. true: the loop goes on, false: nothing to do for the feed
   */
  private async stepBack(target: number): Promise<boolean> {
    if (this.backDead || this.backRun < BACK_AFTER || performance.now() < this.backOffUntil) return false;
    const i = coverIndex(this.back, target);
    if (i < 0) return this.fill(target, true);
    // the forward decoder stands somewhere else: it must not go on from there under a kept frame
    if (this.gen) {
      await this.closeGen();
      if (this.disposed) return false;
      if (this.resting || this.target !== target) return true;
    }
    this.misses = 0;
    this.show(i);
    // enough frames behind the playhead, or the first frame of the file is among them
    if (i >= Math.max(2, this.capacity >> 1) || this.backFloor) return false;
    return this.fill(target, false);
  }

  /** a canvas of the feed's own for a kept frame */
  private blank(width: number, height: number): Surface {
    let canvas = this.spare.pop();
    if (!canvas) {
      canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(width, height) : document.createElement('canvas');
      this.own.add(canvas);
      this.canvases.add(canvas);
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return canvas;
  }

  /**
   * the decoder of the backward stretches. one for the whole drag: a decoder that is set up anew for every stretch
   * takes longer to start than to decode the stretch
   */
  private async backDecoder(): Promise<VideoDecoder | null> {
    if (this.decoder) {
      // emptied by a dropped stretch
      if (this.decoder.state === 'unconfigured' && this.config) this.decoder.configure(this.config);
      return this.decoder.state === 'configured' ? this.decoder : null;
    }
    if (this.backDead || !this.track || typeof VideoDecoder === 'undefined') return null;
    const config = await this.track.getDecoderConfig();
    if (!config || this.disposed || this.decoder) return this.decoder;
    this.config = config;
    const decoder = new VideoDecoder({
      output: (frame) => this.decoded(frame),
      error: () => {
        this.backDead = true;
      },
    });
    decoder.configure(config);
    this.decoder = decoder;
    return decoder;
  }

  /** the stretch that is decoded right now is not wanted any more: what waits in the decoder is thrown away */
  private dropFill(): void {
    const job = this.job;
    if (!job || job.dropped) return;
    job.dropped = true;
    try {
      if (this.decoder && this.decoder.state === 'configured') this.decoder.reset();
    } catch {
      // closed meanwhile
    }
  }

  private dropDecoder(): void {
    const decoder = this.decoder;
    this.decoder = null;
    this.job = null;
    try {
      if (decoder && decoder.state !== 'closed') decoder.close();
    } catch {
      // already closed
    }
  }

  /** a frame of the stretch that is decoded: kept on a canvas when it is one of the wanted ones */
  private decoded(frame: VideoFrame): void {
    try {
      const job = this.job;
      if (!job || job.dropped || this.disposed) return;
      const at = frame.timestamp / 1e6;
      const length = frame.duration ? frame.duration / 1e6 : 0;
      if (length > 0) this.frameLen = length;
      if (at < job.keepAt - EPS || at >= job.end - EPS) return;
      job.keepAt = job.stride > 1 ? at + job.stride * this.frameLen : job.from;
      // the bitmap stays on the graphics card, like the frame it is made of
      job.pending.push(
        createImageBitmap(frame)
          .then((bitmap) => {
            if (job.dropped || this.disposed || this.job !== job) {
              bitmap.close();
              return;
            }
            this.bitmaps.add(bitmap);
            job.got.push({ canvas: bitmap, timestamp: at, duration: length });
          })
          .catch(() => undefined),
      );
    } finally {
      frame.close();
    }
  }

  /**
   * decode a stretch behind the playhead and keep its frames. `fresh`: the kept frames are of no use for the wanted
   * time, they are dropped and the stretch is aimed at where the playhead is going. else: the stretch right before
   * the kept ones.
   */
  private async fill(target: number, fresh: boolean): Promise<boolean> {
    const track = this.track;
    const packets = this.packets;
    if (!track || !packets || this.backDead) return false;
    const count = Math.max(2, this.capacity >> 1);
    const len = this.frameLen;
    const stride = backStride(this.speed, len, this.fillMs, count);
    // too fast for the feed: the element does it alone, as it would without the kept frames
    if (stride === 0) return false;
    let from: number;
    let end: number;
    if (fresh) {
      ({ from, end } = backStretch(target, this.speed, this.fillMs, count, stride, len));
    } else {
      end = this.back[0]!.timestamp;
      if (end <= EPS) {
        this.backFloor = true;
        return false;
      }
      from = Math.max(0, end - count * stride * len);
    }
    let decoder: VideoDecoder | null = null;
    let first: EncodedPacket | null = null;
    try {
      decoder = await this.backDecoder();
      if (decoder) first = await packets.getKeyPacket(from);
    } catch {
      this.backDead = true;
    }
    if (this.disposed || !decoder || !first) return false;
    if (this.resting || this.target === null || !this.backward) return true;
    // the forward decoder is not needed while the playhead moves back
    await this.closeGen();
    if (this.disposed) return false;
    // rested or turned around while the forward decoder closed
    if (this.resting || this.target === null || !this.backward) return true;
    if (fresh) {
      // the frame shown so far stays up until the first new one is there. a canvas of the forward decoder is drawn
      // over by its next start: the picture moves to a canvas of the feed's own
      const hold = this.cur;
      if (hold && !this.mine(hold.canvas)) this.cur = this.keep(hold);
      this.dropBack();
    }
    // a fresh stretch also spans the way from where the playhead is to where it is going
    const job: BackJob = { from, end, stride, keepAt: from, most: fresh ? this.capacity : count, got: [], pending: [], dropped: false };
    this.job = job;
    this.filling = { from, end };
    const started = performance.now();
    let slice = started;
    // frames are stored in another order than they are shown: a few packets past the end belong to the stretch
    const past = end + REORDER_FRAMES * len;
    try {
      // all packets go to the decoder at once: it works through them on its own thread, and waiting for it packet
      // by packet costs more than the decoding
      for await (const packet of packets.packets(first)) {
        if (packet.timestamp >= past || job.dropped || decoder.state !== 'configured') break;
        decoder.decode(packet.toEncodedVideoChunk());
        if (performance.now() - slice > SLICE_MS) {
          await pause();
          slice = performance.now();
        }
        const now = this.target;
        // rested, turned around, or far behind the stretch already
        if (this.disposed || this.resting || now === null || !this.backward || now < from - (end - from)) this.dropFill();
      }
      if (!job.dropped && decoder.state === 'configured') await decoder.flush();
      await Promise.all(job.pending);
    } catch {
      // a dropped stretch ends its flush with an error, anything else is the decoder giving up
      if (!job.dropped) this.backDead = true;
    } finally {
      this.filling = null;
      this.job = null;
    }
    const left = job.dropped;
    const got = job.got;
    if (this.disposed) return false;
    if (this.backDead) {
      for (const f of got) this.free(f.canvas);
      this.dropDecoder();
      return false;
    }
    if (left) {
      for (const f of got) this.free(f.canvas);
      if (this.backward && this.target !== null && !this.resting) this.missed();
      return true;
    }
    const took = performance.now() - started;
    this.fillMs = 0.5 * this.fillMs + 0.5 * took;
    if (got.length === 0) {
      if (fresh) this.missed();
      else this.backFloor = true;
      return true;
    }
    got.sort((x, y) => x.timestamp - y.timestamp);
    // the ones nearest the end are the ones the playhead comes to first
    while (got.length > job.most) this.free(got.shift()!.canvas);
    // a kept frame stands until the next kept one starts
    for (let i = 0; i < got.length; i++) {
      const f = got[i]!;
      const after = i + 1 < got.length ? got[i + 1]!.timestamp : !fresh && this.back.length > 0 ? this.back[0]!.timestamp : null;
      f.duration = after !== null && after > f.timestamp ? after - f.timestamp : (f.duration > 0 ? f.duration : len) * stride;
    }
    this.back = fresh ? got : [...got, ...this.back];
    while (this.back.length > this.capacity) {
      const last = this.back[this.back.length - 1]!;
      if (last === this.cur) break;
      this.back.pop();
      this.free(last.canvas);
    }
    if (fresh && coverIndex(this.back, this.target ?? Number.NaN) < 0) this.missed();
    return true;
  }

  /** the one loop that owns the decoder: every call that finds it running leaves the work to it */
  private async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (this.state === 'new') await this.open();
      let slice = performance.now();
      while (!this.disposed && this.state === 'ready') {
        if (this.resting) {
          this.resting = false;
          await this.closeGen();
          this.letGo();
          continue;
        }
        const target = this.target;
        if (target === null || !this.track) break;
        // the wanted time reached the frame that was decoded ahead
        if (this.ahead && startsBy(this.ahead.timestamp, target)) {
          this.cur = this.ahead;
          this.ahead = null;
          this.told = true;
          this.onFrame();
          continue;
        }
        // the frame after the held one is here and the wanted time is before it: the held frame is the one
        if (this.ahead && this.cur && startsBy(this.cur.timestamp, target)) break;
        const held = this.held();
        // decode on or start again depends on where the key frame before the wanted time lies
        let key: number | null = null;
        if (feedStep(held, this.gen !== null, target, this.backward) !== 'have') {
          key = await this.keyBefore(target);
          if (this.disposed) break;
          // a newer wanted time came meanwhile: decide for that one
          if (this.target !== target || this.resting) continue;
        }
        const step = feedStep(held, this.gen !== null, target, this.backward, key);
        if (step === 'have' && !this.told) {
          // the wanted frame came in between two tells
          this.told = true;
          this.lastTell = performance.now();
          this.onFrame();
        }
        if (step === 'have') break;
        if (step === 'idle') {
          if (await this.stepBack(target)) continue;
          break;
        }
        let fresh = false;
        if (step === 'restart') {
          // a time the file has no frame for must not make the feed start over and over
          if (this.startsFor !== target) {
            this.startsFor = target;
            this.starts = 0;
          }
          if (++this.starts > MAX_STARTS) {
            this.target = null;
            break;
          }
          await this.closeGen();
          if (this.disposed || !this.track) break;
          // three canvases: the one on screen stays untouched while the next frames are decoded
          if (!this.sink) this.sink = new CanvasSink(this.track, { poolSize: 3 });
          // from the key frame before the wanted time: its picture is there after one decode and the frames on the
          // way to the wanted one are shown as they come, instead of nothing until the wanted frame itself
          this.gen = this.sink.canvases(key !== null ? key : target);
          fresh = true;
        }
        const gen = this.gen;
        if (!gen) break;
        const next = await gen.next();
        if (this.disposed) break;
        if (next.done) {
          // the end of the file: the frame it holds is the last one and stands for every later time
          await this.closeGen();
          if (this.cur && !fresh) this.fileEnd = this.cur.timestamp;
          // a new start that gives nothing would loop: wait for the next wanted time
          else if (this.target === target) this.target = null;
          continue;
        }
        this.canvases.add(next.value.canvas);
        // past the wanted time: it lies in the frame held so far (or in a gap after it), this one waits its turn
        if (this.cur && !fresh && !startsBy(next.value.timestamp, target) && next.value.timestamp > this.cur.timestamp) {
          this.ahead = next.value;
          this.told = true;
          this.onFrame();
          continue;
        }
        this.cur = next.value;
        const now = performance.now();
        const wanted = this.target;
        const span = this.held();
        const there = wanted !== null && span !== null && frameDistance(span.start, span.length, wanted) === 0;
        this.told = there || now - this.lastTell >= TELL_EVERY_MS;
        if (this.told) {
          this.lastTell = now;
          this.onFrame();
        }
        if (now - slice > SLICE_MS) {
          await pause();
          slice = performance.now();
        }
      }
    } catch {
      // a file the decoder gives up on: the element does it alone from here
      this.state = 'off';
    } finally {
      this.running = false;
      if (this.disposed || this.state === 'off') await this.teardown();
    }
  }
}
