/**
 * what the browser said it can encode, remembered for the session, and when to ask.
 *
 * the export dialog asks for every size / frame rate / quality it shows. the answer for the same question does
 * not change while the app runs, so it is asked once: opening the dialog again or going back to a setting is
 * ready at once. only a yes is kept. a no is asked again next time, it may have been a bad moment (the gpu
 * process restarting) and must not lock a format out for the rest of the session.
 */
import type { ExportPlan, PlanRequest } from './exporter';

export function planKey(req: PlanRequest): string {
  return `${req.container}|${req.width}x${req.height}|${req.fps}|${req.quality}`;
}

export interface PlanMemo {
  get(req: PlanRequest): ExportPlan | undefined;
  put(req: PlanRequest, plan: ExportPlan | null | undefined): void;
  readonly size: number;
}

/** most answers kept (a session never comes near it, it only stops a runaway caller) */
export const PLAN_MEMO_MAX = 400;

export function createPlanMemo(max = PLAN_MEMO_MAX): PlanMemo {
  const known = new Map<string, ExportPlan>();
  return {
    get: (req) => known.get(planKey(req)),
    put(req, plan) {
      if (!plan) return;
      const key = planKey(req);
      if (!known.has(key) && known.size >= max) {
        const oldest = known.keys().next();
        if (!oldest.done) known.delete(oldest.value);
      }
      known.set(key, { codec: plan.codec, bitrate: plan.bitrate });
    },
    get size() {
      return known.size;
    },
  };
}

/**
 * how long to wait before asking: not at all for the first question in a while (the dialog just opened, one
 * click on a preset), the debounce time when the last question was only a moment ago (typing a number, dragging).
 */
export function probeDelay(sinceLastMs: number, debounceMs: number): number {
  if (!(debounceMs > 0)) return 0;
  if (Number.isNaN(sinceLastMs)) return debounceMs;
  return sinceLastMs >= debounceMs ? 0 : debounceMs;
}
