/**
 * who takes space / enter when a pressable thing (a button, a card with role="button") has the focus.
 *
 * space and enter press a control that was reached with the keyboard. one that only has the focus because it
 * was clicked leaves them alone: space after a click plays / pauses, it does not repeat the click. without this
 * rule a click on an effect card followed by space added the same effect again on every press.
 *
 * `:focus-visible` cannot answer this: the browser turns it on for the focused element as soon as ANY key goes
 * down, so at the moment space arrives a clicked card already matches it. so the editor keeps track itself of
 * how the focus got where it is: the focus moved while the last thing the user did was a key (tab, an arrow in
 * a menu) = keyboard, the last thing was a press of the pointer = not.
 */

export interface FocusSource {
  /** a pointer went down */
  pointer(): void;
  /** a key went down */
  key(): void;
  /** the focus moved to another element */
  focus(): void;
  /** the window lost the focus (the user went to another app) */
  windowBlur(): void;
  /** did the element that has the focus get it from the keyboard? */
  byKeyboard(): boolean;
}

export function createFocusSource(): FocusSource {
  let lastWasKey = false;
  let byKey = false;
  let away = false;
  return {
    pointer() {
      lastWasKey = false;
      // a press anywhere ends keyboard driving, also when the focus stays where it is (a click on the focused card)
      byKey = false;
    },
    key() {
      lastWasKey = true;
    },
    focus() {
      // the focus that comes back with the window is the old one: alt + tab is a key, but nobody tabbed to the card
      if (away) {
        away = false;
        return;
      }
      byKey = lastWasKey;
    },
    windowBlur() {
      away = true;
    },
    byKeyboard: () => byKey,
  };
}

/** the one the app uses. `watchFocusSource` feeds it. */
export const focusSource = createFocusSource();

/** start feeding `focusSource` from a window. call once at startup. returns the undo. */
export function watchFocusSource(win: Window, source: FocusSource = focusSource): () => void {
  const pointer = () => source.pointer();
  const key = () => source.key();
  const focus = () => source.focus();
  // blur does not bubble: without capture this only hears the window itself losing the focus
  const blur = (e: Event) => {
    if (e.target === win) source.windowBlur();
  };
  win.addEventListener('pointerdown', pointer, true);
  win.addEventListener('keydown', key, true);
  win.addEventListener('focusin', focus, true);
  win.addEventListener('blur', blur);
  return () => {
    win.removeEventListener('pointerdown', pointer, true);
    win.removeEventListener('keydown', key, true);
    win.removeEventListener('focusin', focus, true);
    win.removeEventListener('blur', blur);
  };
}

/** true when the focused element was reached with the keyboard, not clicked */
export function focusedByKeyboard(source: FocusSource = focusSource): boolean {
  return source.byKeyboard();
}

/** a keydown on a card: is it a press of that card? (not a key that bubbled up from something inside it) */
export function pressesCard(e: { key: string; target: unknown; currentTarget: unknown }, source: FocusSource = focusSource): boolean {
  if (e.target !== e.currentTarget) return false;
  if (e.key !== 'Enter' && e.key !== ' ') return false;
  return source.byKeyboard();
}
