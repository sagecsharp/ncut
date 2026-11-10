import type { ClipType } from '../../types';

/** the tabs of the clip inspector. "all" is the old long list. */
export type InspectorTab = 'basic' | 'look' | 'animate' | 'sound' | 'all';

export const INSPECTOR_TABS: { id: InspectorTab; label: string; title: string }[] = [
  { id: 'basic', label: 'basic', title: 'name, timing, the main settings, transform, speed, fades' },
  { id: 'look', label: 'look', title: 'style, color, mask, effects, 3d, links' },
  { id: 'animate', label: 'animate', title: 'keyframes, motion, path, repeat, transition' },
  { id: 'sound', label: 'sound', title: 'volume and tempo' },
  { id: 'all', label: 'all', title: 'every section in one list' },
];

/** every section id of the clip inspector in the order of the "all" tab (the old long list) */
export const SECTION_ORDER = [
  'clip',
  'animation',
  'beat-sync',
  'effect',
  'effect-beat',
  'camera',
  'focus',
  'text',
  'text-style',
  'text-anim',
  'shape',
  'transform',
  'threed',
  'path',
  'repeat',
  'attach',
  'look',
  'color',
  'mask',
  'clip-effects',
  'motion',
  'transition',
  'audio',
  'tempo',
  'speed',
  'fades',
] as const;

export type SectionId = (typeof SECTION_ORDER)[number];

/** the one group (not "all") each section belongs to */
export const TAB_OF: Record<SectionId, Exclude<InspectorTab, 'all'>> = {
  clip: 'basic',
  effect: 'basic',
  'effect-beat': 'basic',
  camera: 'basic',
  focus: 'basic',
  text: 'basic',
  shape: 'basic',
  transform: 'basic',
  speed: 'basic',
  fades: 'basic',
  'text-style': 'look',
  look: 'look',
  color: 'look',
  mask: 'look',
  'clip-effects': 'look',
  threed: 'look',
  attach: 'look',
  animation: 'animate',
  'beat-sync': 'animate',
  motion: 'animate',
  'text-anim': 'animate',
  path: 'animate',
  repeat: 'animate',
  transition: 'animate',
  audio: 'sound',
  tempo: 'sound',
};

/** the sections a clip has, in the order of the "all" tab. one place for the rule, the inspector uses it too. */
export function sectionsOf(type: ClipType, hasAudio: boolean): SectionId[] {
  const visual = type === 'video' || type === 'image' || type === 'text' || type === 'shape';
  const sound = hasAudio && (type === 'video' || type === 'audio');
  return SECTION_ORDER.filter((id) => {
    switch (id) {
      case 'effect':
      case 'effect-beat':
        return type === 'effect';
      case 'camera':
      case 'focus':
        return type === 'camera';
      case 'text':
      case 'text-style':
      case 'text-anim':
        return type === 'text';
      case 'shape':
        return type === 'shape';
      case 'transform':
        return type !== 'audio' && type !== 'effect' && type !== 'camera';
      case 'threed':
      case 'path':
      case 'repeat':
      case 'look':
      case 'color':
      case 'mask':
      case 'clip-effects':
      case 'motion':
      case 'transition':
        return visual;
      case 'audio':
      case 'tempo':
        return sound;
      case 'speed':
        return type === 'video' || type === 'audio';
      default:
        return true;
    }
  });
}

/** the tabs worth showing for those sections: only groups that have a section, "all" last */
export function tabsFor(sections: readonly SectionId[]): InspectorTab[] {
  const used = new Set(sections.map((s) => TAB_OF[s]));
  return INSPECTOR_TABS.filter((t) => t.id === 'all' || used.has(t.id as Exclude<InspectorTab, 'all'>)).map((t) => t.id);
}

/** the tab to show: the wanted one when this clip has it, else "basic" (the wish itself is not forgotten) */
export function resolveTab(wanted: InspectorTab, tabs: readonly InspectorTab[]): InspectorTab {
  return tabs.includes(wanted) ? wanted : 'basic';
}

/** true when a section shows on a tab */
export function onTab(tab: InspectorTab, section: SectionId): boolean {
  return tab === 'all' || TAB_OF[section] === tab;
}

/** the tab one arrow key moves to (wraps around). null for other keys. */
export function arrowTab(tabs: readonly InspectorTab[], from: InspectorTab, key: string): InspectorTab | null {
  const i = tabs.indexOf(from);
  if (i < 0) return null;
  if (key === 'ArrowRight') return tabs[(i + 1) % tabs.length]!;
  if (key === 'ArrowLeft') return tabs[(i - 1 + tabs.length) % tabs.length]!;
  if (key === 'Home') return tabs[0]!;
  if (key === 'End') return tabs[tabs.length - 1]!;
  return null;
}
