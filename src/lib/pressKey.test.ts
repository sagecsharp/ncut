import { describe, expect, it } from 'vitest';
import { createFocusSource, pressesCard, watchFocusSource } from './pressKey';

describe('focus source', () => {
  it('a clicked element does not have the keyboard focus, however many keys follow', () => {
    const s = createFocusSource();
    s.pointer();
    s.focus();
    expect(s.byKeyboard()).toBe(false);
    // the space that would have added the effect again, and a few more keys: the focus never moved
    s.key();
    expect(s.byKeyboard()).toBe(false);
    s.key();
    s.key();
    expect(s.byKeyboard()).toBe(false);
  });
  it('an element reached with tab has it', () => {
    const s = createFocusSource();
    s.key();
    s.focus();
    expect(s.byKeyboard()).toBe(true);
  });
  it('a menu opened with the pointer and walked with the arrows has it', () => {
    const s = createFocusSource();
    s.pointer();
    s.focus(); // the menu focuses its first item
    expect(s.byKeyboard()).toBe(false);
    s.key(); // arrow down
    s.focus(); // the menu moves the focus
    expect(s.byKeyboard()).toBe(true);
  });
  it('a click on the element that already has the keyboard focus ends it', () => {
    const s = createFocusSource();
    s.key();
    s.focus();
    s.pointer(); // no focus event: it stays where it is
    expect(s.byKeyboard()).toBe(false);
  });
  it('coming back to the window keeps what it was', () => {
    const clicked = createFocusSource();
    clicked.pointer();
    clicked.focus();
    clicked.key(); // alt of alt + tab
    clicked.windowBlur();
    clicked.focus(); // the window is back, the card has the focus again
    expect(clicked.byKeyboard()).toBe(false);

    const tabbed = createFocusSource();
    tabbed.key();
    tabbed.focus();
    tabbed.pointer(); // a click in another app does not reach us, but a press on our title bar might
    tabbed.key();
    tabbed.focus();
    tabbed.windowBlur();
    tabbed.focus();
    expect(tabbed.byKeyboard()).toBe(true);
    // and the next real focus move counts again
    tabbed.pointer();
    tabbed.focus();
    expect(tabbed.byKeyboard()).toBe(false);
  });
});

describe('pressesCard', () => {
  const card = {};
  const tabbed = () => {
    const s = createFocusSource();
    s.key();
    s.focus();
    return s;
  };
  const clicked = () => {
    const s = createFocusSource();
    s.pointer();
    s.focus();
    s.key();
    return s;
  };
  it('space and enter press a card that was reached with the keyboard', () => {
    expect(pressesCard({ key: ' ', target: card, currentTarget: card }, tabbed())).toBe(true);
    expect(pressesCard({ key: 'Enter', target: card, currentTarget: card }, tabbed())).toBe(true);
  });
  it('a card that was only clicked leaves space and enter alone (space plays instead of adding the effect again)', () => {
    expect(pressesCard({ key: ' ', target: card, currentTarget: card }, clicked())).toBe(false);
    expect(pressesCard({ key: 'Enter', target: card, currentTarget: card }, clicked())).toBe(false);
  });
  it('other keys never press', () => {
    for (const key of ['a', 'Tab', 'Escape', 'ArrowDown', 'Spacebar']) expect(pressesCard({ key, target: card, currentTarget: card }, tabbed())).toBe(false);
  });
  it('a key from something inside the card (the favorite star) is not a press of the card', () => {
    expect(pressesCard({ key: ' ', target: {}, currentTarget: card }, tabbed())).toBe(false);
  });
});

describe('watchFocusSource', () => {
  it('feeds the source from window events and lets go again', () => {
    const handlers = new Map<string, Array<{ fn: (e: Event) => void; capture: boolean }>>();
    const win = {
      addEventListener(type: string, fn: (e: Event) => void, capture?: boolean) {
        handlers.set(type, [...(handlers.get(type) ?? []), { fn, capture: !!capture }]);
      },
      removeEventListener(type: string, fn: (e: Event) => void) {
        handlers.set(type, (handlers.get(type) ?? []).filter((h) => h.fn !== fn));
      },
    } as unknown as Window;
    const fire = (type: string, target: unknown = {}) => {
      for (const h of handlers.get(type) ?? []) h.fn({ target } as Event);
    };
    const s = createFocusSource();
    const stop = watchFocusSource(win, s);
    fire('keydown');
    fire('focusin');
    expect(s.byKeyboard()).toBe(true);
    fire('pointerdown');
    expect(s.byKeyboard()).toBe(false);
    // an element losing the focus is not the window losing it
    fire('keydown');
    fire('blur', {});
    fire('focusin');
    expect(s.byKeyboard()).toBe(true);
    fire('pointerdown');
    fire('blur', win);
    fire('keydown');
    fire('focusin');
    expect(s.byKeyboard()).toBe(false);
    // the blur listener must not be a capturing one (it would hear every element)
    expect(handlers.get('blur')![0]!.capture).toBe(false);
    stop();
    expect([...handlers.values()].every((l) => l.length === 0)).toBe(true);
  });
});
