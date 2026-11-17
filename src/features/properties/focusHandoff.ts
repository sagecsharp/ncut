import { focusedByKeyboard } from '../../lib/pressKey';

/** the project button and the back button swap the inspector, which unmounts the focused one: the new one takes the focus when it was a key press */
let want: 'project' | 'back' | null = null;

/** call in the click of a button that is about to unmount: the button named `next` takes the focus when it mounts, after a key press only */
export function handFocusTo(next: 'project' | 'back'): void {
  want = focusedByKeyboard() ? next : null;
}

/** a ref callback for the button called `name` */
export function takesFocus(name: 'project' | 'back'): (el: HTMLElement | null) => void {
  return (el) => {
    if (!el || want !== name) return;
    want = null;
    el.focus();
  };
}
