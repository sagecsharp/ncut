import { useEditor } from '../../store/editorStore';
import { hasSoundApart, syncLabel } from '../../lib/soundPair';
import { tip } from '../shell/tip';
import type { Clip } from '../../types';
import { openClipMenuAt } from './commands';
import './syncBadge.css';

/** what the badge tip says for an offset label like '+3f', '-0.4f' or '+12.5s' */
function offsetDoes(clip: Clip, label: string): string {
  const me = clip.type === 'audio' ? 'sound' : 'picture';
  const other = clip.type === 'audio' ? 'picture' : 'sound';
  const unit = label.endsWith('s') ? ' seconds' : label === '+1f' || label === '-1f' ? ' frame' : ' frames';
  const amount = `${label.slice(1, -1)}${unit}`;
  const when = label.startsWith('+') ? 'after' : 'before';
  return `this ${me} plays ${amount} ${when} its ${other}. click for move into sync or slip into sync`;
}

/** the out of sync badge of a clip, and the mark of a picture whose sound is apart. ungrouped clips subscribe to nothing */
export function SyncBadge({ clip, w }: { clip: Clip; w: number }) {
  if (!clip.group || (clip.type !== 'video' && clip.type !== 'audio')) return null;
  return <SyncBadgeInner clip={clip} w={w} />;
}

function SyncBadgeInner({ clip, w }: { clip: Clip; w: number }) {
  const label = useEditor((s) => (s.project ? syncLabel(s.project.clips, clip.id, s.project.fps) : null));
  const apart = useEditor((s) => (s.project ? hasSoundApart(s.project.clips, clip.id) : false));
  const dot = w < 28;
  const speed = label === 'speed';
  const name = speed ? 'different speeds' : 'out of sync';
  const does = label === null ? '' : speed ? 'picture and sound play at different speeds, so they drift apart. click for match the speed' : offsetDoes(clip, label);
  return (
    <>
      {apart ? <span className="timeline-sound-apart" hidden /> : null}
      {label !== null ? (
        <button
          type="button"
          className={dot ? 'timeline-sync-badge is-dot' : 'timeline-sync-badge'}
          tabIndex={-1}
          aria-label={dot ? label : undefined}
          {...tip(name, { does })}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            openClipMenuAt(e.currentTarget, clip.id);
          }}
        >
          {dot ? null : label}
        </button>
      ) : null}
    </>
  );
}
