/** applies a typed time: reads the stores for the plan and runs it. the only place the typed time touches state */
import { formatTimeAs } from '../../lib/time';
import type { TimeDisplay } from '../../lib/time';
import { useEditor } from '../../store/editorStore';
import { usePlayback } from '../../store/playback';
import { useTimeDisplay } from '../../store/timeDisplay';
import { useUi } from '../../store/ui';
import { applyNudge } from '../timeline/nudgeActions';
import { planNudge } from '../timeline/timeNudge';
import { nudgeTrimEdge } from '../timeline/trimActions';
import { edgePlan } from '../timeline/trimModes';
import { interaction } from '../timeline/view';
import type { EntryFrom } from './timeEntry';
import { ENTRY_TEXT, fill, planTimeEntry } from './timeEntryPlan';
import type { EntryPlan, EntryState } from './timeEntryPlan';

/** the stores as the plan wants them. null without a project */
export function entryState(from: EntryFrom, mode: TimeDisplay): EntryState | null {
  const ed = useEditor.getState();
  if (!ed.project) return null;
  return { project: ed.project, selection: ed.selection, edge: useUi.getState().trimEdge, time: usePlayback.getState().time, from, mode };
}

/** plans the text from the stores now */
export function planEntryNow(text: string, from: EntryFrom, mode: TimeDisplay): EntryPlan {
  const s = entryState(from, mode);
  if (!s) return { kind: 'none', text: ENTRY_TEXT.hint };
  return planTimeEntry(text, s, { edgePlan, planNudge });
}

/** true closes the field: it did the plan, or there was nothing to do. error and blocked plans and a running gesture keep it open */
export function applyEntryPlan(plan: EntryPlan): boolean {
  if (interaction.gestureActive) return false;
  switch (plan.kind) {
    case 'none':
      return true;
    case 'error':
      return false;
    case 'seek': {
      const pb = usePlayback.getState();
      pb.pause();
      pb.seek(plan.time);
      if (plan.clamped) {
        const fps = useEditor.getState().project?.fps ?? 30;
        useUi.getState().toast(fill(ENTRY_TEXT.clamped, { t: formatTimeAs(plan.time, fps, useTimeDisplay.getState().mode) }));
      }
      return true;
    }
    case 'step':
      usePlayback.getState().stepFrames(plan.frames);
      return true;
    case 'move':
      if (plan.blocked) return false;
      return applyNudge(plan.plan, false);
    case 'trim':
      if (plan.blocked) return false;
      nudgeTrimEdge(plan.frames);
      return true;
  }
}
