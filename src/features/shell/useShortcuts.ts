import { useEffect } from 'react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { interaction } from '../timeline/view';
import { usePalette } from './paletteStore';
import { findShortcut } from './shortcuts';

const NON_TEXT_INPUTS = new Set(['range', 'checkbox', 'radio', 'color', 'button', 'file', 'submit', 'reset']);

/** true when the key should go to a text-like control instead of the shortcut table */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') return !NON_TEXT_INPUTS.has((target as HTMLInputElement).type);
  return false;
}

/** true when a focused control needs these keys for itself: a slider (arrows, home, end, page keys) or a select (letters, arrows) */
export function ownsKey(target: EventTarget | null, key: string): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === 'SELECT') return key.length === 1 || key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown', 'Enter', ' '].includes(key);
  if (target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'range') {
    return key.startsWith('Arrow') || ['Home', 'End', 'PageUp', 'PageDown'].includes(key);
  }
  // a control reached with the keyboard (tab) is pressed with space / enter. one that only has focus because it
  // was clicked does not take them: space after a click still plays
  if ((key === ' ' || key === 'Enter') && PRESSABLE.has(pressRole(target))) {
    try {
      return target.matches(':focus-visible');
    } catch {
      return false;
    }
  }
  return false;
}

const PRESSABLE = new Set(['button', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'link', 'summary']);

/** what kind of pressable thing an element is ('' = none) */
function pressRole(el: HTMLElement): string {
  const role = el.getAttribute('role');
  if (role) return role;
  const tag = el.tagName;
  if (tag === 'BUTTON') return 'button';
  if (tag === 'SUMMARY') return 'summary';
  if (tag === 'A') return (el as HTMLAnchorElement).href ? 'link' : '';
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return type === 'checkbox' || type === 'radio' ? type : type === 'button' || type === 'submit' ? 'button' : '';
  }
  return '';
}

/** a modal is open: store-driven dialogs or any local Dialog (they render a .dialog-backdrop) */
const modalOpen = () => usePalette.getState().open || useUi.getState().dialog !== null || document.querySelector('.dialog-backdrop') !== null;
/** registers the global keyboard shortcuts of the editor. call once from EditorLayout. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      if (!e.ctrlKey && !e.metaKey && ownsKey(e.target, e.key)) return;
      // dialogs own the keyboard (they handle escape themselves)
      if (modalOpen()) return;
      if (!useEditor.getState().project) return;
      const shortcut = findShortcut(e);
      if (!shortcut) return;
      // a drag keeps writing on top of the state it started from: editing now would corrupt the undo history
      if (shortcut.mutates && interaction.gestureActive) {
        e.preventDefault();
        return;
      }
      if (e.repeat && !shortcut.repeat) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      shortcut.run();
    };

    // a focused button would otherwise "click" on space keyup after we handled keydown
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code !== 'Space' && e.key !== ' ') return;
      if (isTypingTarget(e.target) || modalOpen()) return;
      if (ownsKey(e.target, ' ')) return;
      e.preventDefault();
    };

    // a select keeps the focus after a pick with the mouse, and then takes arrows / space / letters for itself:
    // the next arrow press would change its value again instead of stepping a frame. so a select that was
    // changed with the pointer gives the focus back. one that is driven with the keyboard keeps it.
    let pointerLast = false;
    const onPointerDown = () => {
      pointerLast = true;
    };
    const onAnyKey = () => {
      pointerLast = false;
    };
    const onChange = (e: Event) => {
      const el = e.target;
      if (pointerLast && el instanceof HTMLSelectElement) el.blur();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onAnyKey, true);
    window.addEventListener('change', onChange);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onAnyKey, true);
      window.removeEventListener('change', onChange);
    };
  }, []);
}
