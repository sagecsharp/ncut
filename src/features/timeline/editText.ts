/**
 * the words of three point edits. pure: never imports reasons.ts, which imports editPlan.ts, which imports this.
 */
import type { Project } from '../../types';
import { formatSeconds, formatTimecode } from '../../lib/time';
import type { EditResult, EditStop } from './editPlan';
import { TRIM_TEXT, clipLabel, lockedTracksText } from './trimText';

export const EDIT_TEXT = {
  mediaGone: 'this media is not in the project any more',
  pictureOff: 'the picture target is off: click the target button of a video track',
  soundOff: 'the sound target is off: click the target button of an audio track',
  targetsOff: 'both targets are off: click the target button of a track',
  targetLocked: '{track} is locked: unlock it or pick another target',
  needsRange: 'fit to the range needs an in and an out point on the timeline',
  tooShort: 'the edit would be shorter than 0.05 s',
  beforeZero: 'ending at the out point it would start before 0 s',
  mediaShort: 'the media has {have} from {where}, the range needs {need}. fit to the range changes the speed instead',
  mediaShortBack: 'the media has {have} before its out point, the range needs {need}',
  fitFast: 'fit to the range would play at {speed}x, faster than 4x: make the range longer or the marked part shorter',
  fitSlow: 'fit to the range would play at {speed}x, slower than 0.25x: make the range shorter or the marked part longer',
  noClipUnder: 'no clip under the playhead on {track} to replace',
  noClipUnderAny: 'no clip under the playhead to replace: select one',
  replaceKind: '{clip} is a {kind} clip: it takes {want}',
  replaceText: 'only video, audio and picture clips can be replaced',
  replaceSame: 'the clip already shows this frame of the media',
  mediaBefore: 'the media starts too late for {clip}: move the source playhead later',
  mediaAfter: 'the media ends before {clip} does: move the source playhead earlier',
  splitStop: '{mode} stopped: {clip} could not be split at the edit',
  moveStop: 'insert stopped: {clip} could not move',
  slipStop: 'replace stopped: {clip} could not slide its media',
  placeStop: '{mode} stopped: the new clip did not fit on {track}',
  overlapStop: '{mode} stopped: {clip} would overlap {other}',
  inserted: 'inserted {len} of "{name}" at {at}, the clips after it moved {len} later',
  overwrote: 'overwrote {len} at {at} with "{name}"',
  fitted: 'fit {len} of "{name}" to the range at {speed}x',
  replaced: 'replaced {clip} with "{name}", frame matched',
  slipped: 'slipped {clip}: this frame of the media is at the playhead now',
  appended: 'appended {len} of "{name}" at {at}',
  kept: '{n} {clips} at the edit stayed whole',
  soundsKept: '{n} sound {clips} kept the old media',
  rangeCleared: 'the in and out points were cleared',
  inCleared: 'the in point was cleared',
  outCleared: 'the out point was cleared',
  undoLate: 'the timeline changed since that edit: ctrl+z goes back one step at a time',
  atRange: 'in to out', atIn: 'at the in point', atOut: 'ending at the out point', atPlayhead: 'at the playhead',
  onNew: 'a new {kind} track',
  fourth: 'the range sets the length, the source out is not used',
  backtimed: 'backtimed from the source out',
  fitDoes: 'the marked part fills the {len} in to out range at {speed}x',
  targetsAuto: 'targets are auto again: the lowest video track and the top audio track',
  targetsSet: 'targets: {tracks}',
  targetsNone: 'select a clip on an unlocked track first',
} as const;

/** one pass with a function replacer, so nothing in a name is read as a pattern or scanned again */
export function fillEditText(text: string, v: Readonly<Record<string, string | number>>): string {
  return text.replace(/\{(\w+)\}/g, (all, k: string) => (Object.prototype.hasOwnProperty.call(v, k) ? String(v[k]) : all));
}

const trackName = (p: Pick<Project, 'tracks'>, id: string | undefined): string => p.tracks.find((t) => t.id === id)?.name ?? 'a track';

/** the words of a clip's type for replace-kind: what it is and what it takes */
function kindWords(type: string | undefined): { kind: string; want: string } {
  if (type === 'audio') return { kind: 'audio', want: 'audio or a video with sound' };
  if (type === 'image') return { kind: 'picture', want: 'only pictures' };
  return { kind: 'video', want: 'only video media' };
}

const round2 = (s: number): string => String(Math.round(s * 100) / 100);

const STOP_KEY: Record<EditStop['why'], keyof typeof EDIT_TEXT> = {
  'media-gone': 'mediaGone',
  'picture-off': 'pictureOff',
  'sound-off': 'soundOff',
  'targets-off': 'targetsOff',
  'target-locked': 'targetLocked',
  'needs-range': 'needsRange',
  'too-short': 'tooShort',
  'before-zero': 'beforeZero',
  'media-short': 'mediaShort',
  'media-short-back': 'mediaShortBack',
  'fit-fast': 'fitFast',
  'fit-slow': 'fitSlow',
  'no-clip-under': 'noClipUnder',
  'replace-kind': 'replaceKind',
  'replace-text': 'replaceText',
  'replace-same': 'replaceSame',
  'media-before': 'mediaBefore',
  'media-after': 'mediaAfter',
};

/** why a plan stopped, in words. every {field} of the text is filled */
export function editStopText(stop: EditStop, p: Pick<Project, 'clips' | 'tracks' | 'assets'>): string {
  const key = stop.why === 'no-clip-under' && stop.trackId === undefined ? 'noClipUnderAny' : STOP_KEY[stop.why];
  const type = stop.clipId !== undefined ? p.clips.find((c) => c.id === stop.clipId)?.type : undefined;
  return fillEditText(EDIT_TEXT[key], {
    clip: clipLabel(p, stop.clipId ?? ''),
    track: trackName(p, stop.trackId),
    have: formatSeconds(stop.have ?? 0),
    need: formatSeconds(stop.need ?? 0),
    where: stop.where === 'in' ? 'its in point' : 'its start',
    speed: round2(stop.speed ?? 1),
    ...kindWords(type),
  });
}

const MODE_WORD: Record<EditResult['mode'], string> = { insert: 'insert', overwrite: 'overwrite', fit: 'fit to the range', replace: 'replace', append: 'append' };

/** the mode word for the stops runEdit fills itself (splitStop, placeStop, overlapStop) */
export const editModeWord = (mode: EditResult['mode']): string => MODE_WORD[mode];

/**
 * what an edit did. p is the project before it (replace names the old clip). swapped false: a replace that only slid the media
 */
export function editDoneText(r: EditResult, p: Pick<Project, 'clips' | 'tracks' | 'fps'>, name: string, swapped = true): string {
  const line = r.mode === 'insert' ? 'inserted' : r.mode === 'overwrite' ? 'overwrote' : r.mode === 'fit' ? 'fitted' : r.mode === 'append' ? 'appended' : swapped ? 'replaced' : 'slipped';
  const q = { clips: p.clips, tracks: p.tracks, assets: [] };
  let text = fillEditText(EDIT_TEXT[line], {
    len: formatSeconds(r.length),
    name,
    at: formatTimecode(r.start, p.fps),
    speed: round2(r.speed),
    clip: clipLabel(q, r.clips[0] ?? ''),
  });
  if (r.lockedTracks.length > 0) text += `. ${TRIM_TEXT.lockedStay.replace('{tracks}', lockedTracksText(q, r.lockedTracks))}`;
  if (r.kept > 0) text += `. ${fillEditText(EDIT_TEXT.kept, { n: String(r.kept), clips: r.kept === 1 ? 'clip' : 'clips' })}`;
  if (r.soundsKept > 0) text += `. ${fillEditText(EDIT_TEXT.soundsKept, { n: String(r.soundsKept), clips: r.soundsKept === 1 ? 'clip' : 'clips' })}`;
  if (r.slivers > 0) text += `. ${r.slivers} piece${r.slivers > 1 ? 's' : ''} shorter than 0.05 s went too`;
  const was = r.rangeCleared;
  if (was) text += `. ${was.in !== undefined && was.out !== undefined ? EDIT_TEXT.rangeCleared : was.in !== undefined ? EDIT_TEXT.inCleared : EDIT_TEXT.outCleared}`;
  return text;
}
