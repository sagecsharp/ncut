/**
 * pictures for a paused preview while the playhead is dragged through a video.
 *
 * a video element starts every seek at the key frame before the wanted time and decodes up to it: with a big file
 * that is 60 to 100 ms per picture, so a drag shows about 15 pictures a second. this feed is a decoder of its own
 * (the same one the export uses) that just keeps going while the playhead moves forward: the next picture is one
 * or a few frames of decoding away. the engine shows the feed's frame only while it is nearer to the wanted time
 * than what the element shows (scrubPlan.feedIsNearer), the element still lands on the exact frame when the drag
 * rests. moving backwards the feed stays out of it.
 */
import { ALL_FORMATS, BlobSource, CanvasSink, EncodedPacketSink, Input } from 'mediabunny';
import type { InputVideoTrack, WrappedCanvas } from 'mediabunny';
import type { DrawSource } from '../../engine/draw';
import { MAX_STARTS, feedIsNearer, feedStep, frameDistance, heldLength, movedBack, startsBy } from './scrubPlan';

/** the decoder is given back after this long without a new wanted time */
const REST_AFTER_MS = 3000;
/** frames on the way to the wanted time are shown at most this often */
const TELL_EVERY_MS = 12;
/** the longest stretch of decoding without letting the page handle input */
const SLICE_MS = 8;

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
  private cur: WrappedCanvas | null = null;
  /** the frame after `cur`, decoded already: the wanted time lies before it (in `cur`, or in a gap after it) */
  private ahead: WrappedCanvas | null = null;
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

  constructor(blob: Blob, onFrame: () => void) {
    this.blob = blob;
    this.onFrame = onFrame;
  }

  /** the playhead wants the picture of this time (seconds into the file). only the newest one counts */
  want(time: number): void {
    if (this.disposed || this.state === 'off' || !Number.isFinite(time)) return;
    this.backward = movedBack(this.lastWant, time, this.backward);
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
        this.state = 'off';
        void this.run();
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
   * would only take the decoder away from the feed. false while it opens, for a file it cannot do, and moving back.
   */
  leads(target: number): boolean {
    if (this.disposed || this.state !== 'ready' || this.target === null) return false;
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
    // nothing open: nothing to give back
    if (!this.gen && !this.cur) return;
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
        if (step === 'have' || step === 'idle') break;
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
