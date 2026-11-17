import { useEffect, useRef, useState } from 'react';
import type { VideoCodecChoice } from './delivery';
import { probeAudio, probeVideoCodecs } from './deliveryProbe';
import type { AudioAsk, CodecStatus, VideoAsk } from './deliveryProbe';
import { probeDelay } from './planMemo';

/** wait this long after the last change before asking the browser */
const PROBE_MS = 250;

export interface DeliveryAsk {
  /** the file the video codecs are asked for. null = no video question */
  video: VideoAsk | null;
  /** only this codec is asked (the advanced part is closed and a set codec got no plan). null = all four */
  only: VideoCodecChoice | null;
  /** the sound codec, bitrates and rates. null = no sound question */
  audio: AudioAsk | null;
}

export interface DeliveryStatus {
  video: Partial<Record<VideoCodecChoice, CodecStatus>>;
  audio: Awaited<ReturnType<typeof probeAudio>> | null;
  /** the answers of the last change are not in yet (the ones shown are the ones before) */
  checking: boolean;
}

interface Answer {
  key: string;
  video: DeliveryStatus['video'];
  audio: DeliveryStatus['audio'];
}

const NONE: DeliveryStatus['video'] = {};

/**
 * what this machine can encode for the choices of the export dialog, asked of the browser after the last change.
 * the video codecs are asked while the advanced part is open (all four), or only the one codec a set choice got no plan for.
 */
export function useDeliveryStatus(ask: DeliveryAsk): DeliveryStatus {
  const key = JSON.stringify(ask);
  const [answer, setAnswer] = useState<Answer | null>(null);
  const lastRef = useRef(Number.NEGATIVE_INFINITY);
  const wanted = ask.video !== null || ask.audio !== null;
  useEffect(() => {
    if (!wanted) {
      setAnswer(null);
      return;
    }
    const q = JSON.parse(key) as DeliveryAsk;
    const ac = new AbortController();
    const delay = probeDelay(performance.now() - lastRef.current, PROBE_MS);
    lastRef.current = performance.now();
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const video = q.video ? await probeVideoCodecs(q.video, { only: q.only ?? undefined, signal: ac.signal }) : NONE;
          const audio = q.audio ? await probeAudio(q.audio, { signal: ac.signal }) : null;
          if (!ac.signal.aborted) setAnswer({ key, video, audio });
        } catch {
          // cancelled by the next change
        }
      })();
    }, delay);
    return () => {
      window.clearTimeout(timer);
      ac.abort();
    };
  }, [key, wanted]);
  return {
    video: answer?.video ?? NONE,
    audio: answer?.audio ?? null,
    checking: wanted && answer?.key !== key,
  };
}
