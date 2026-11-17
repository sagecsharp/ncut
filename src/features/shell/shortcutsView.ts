/** the ? dialog's rows: searched and grouped. pure, so it can be tested without a dom */
import type { SceneScheme } from '../preview/sceneControls';
import { SCENE_HINTS } from '../preview/sceneControls';
import { filterRows } from './paletteSearch';
import { GROUP_LABEL, SHORTCUT_GROUPS } from './shortcuts';
import type { ShortcutGroup } from './shortcuts';
import { capsText } from './tip';

type Caps = readonly (readonly string[])[];

export interface ShortcutView {
  id: string;
  group: ShortcutGroup;
  description: string;
  keys: Caps;
  also?: readonly string[];
}

export interface ShortcutGroupView {
  group: ShortcutGroup;
  label: string;
  rows: ShortcutView[];
}

/** the one line about the mouse in the scene view, for the scheme in use */
export function sceneMouseLine(scheme: SceneScheme): string {
  return `scene view mouse, ${scheme} controls: ` + SCENE_HINTS[scheme].split(/\s{2,}/).join(', ');
}

/** the rows that match the query, in groups (table order, empty groups dropped). the scene mouse line ends the preview group */
export function shortcutGroups(query: string, rows: readonly ShortcutView[], scheme: SceneScheme): ShortcutGroupView[] {
  const all: ShortcutView[] = [...rows, { id: 'scene-mouse', group: 'preview', description: sceneMouseLine(scheme), keys: [] }];
  const hit = filterRows(query, all, (r) => [r.description, ...(r.also ?? []), GROUP_LABEL[r.group], capsText(r.keys)].join(' | '));
  const out: ShortcutGroupView[] = [];
  for (const group of SHORTCUT_GROUPS) {
    const list = hit.filter((r) => r.group === group);
    if (list.length > 0) out.push({ group, label: GROUP_LABEL[group], rows: list });
  }
  return out;
}
