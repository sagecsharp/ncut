import { useEffect } from 'react';
import { useEditor } from '../../store/editorStore';
import { useUi } from '../../store/ui';
import { findShortcut } from './shortcuts';

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** registers the global keyboard shortcuts of the editor. call once from EditorLayout. */
export function useShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      // dialogs own the keyboard (they handle escape themselves)
      if (useUi.getState().dialog !== null) return;
      if (!useEditor.getState().project) return;
      const shortcut = findShortcut(e);
      if (!shortcut) return;
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
      if (isTypingTarget(e.target) || useUi.getState().dialog !== null) return;
      e.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);
}
