import { useRef } from 'react';
import { focusedByKeyboard } from '../../lib/pressKey';
import { INSPECTOR_TABS, arrowTab } from './clipTabs';
import type { InspectorTab } from './clipTabs';

/** the tab the user chose last, kept while the app runs so the next clip opens on it */
let remembered: InspectorTab = 'basic';

export const rememberedTab = (): InspectorTab => remembered;
export const rememberTab = (tab: InspectorTab): void => {
  remembered = tab;
};

/** tab bar of the clip inspector. same markup as the media panel tabs, roving tabindex, left / right move. */
export function InspectorTabs({ tabs, active, onPick }: { tabs: readonly InspectorTab[]; active: InspectorTab; onPick: (tab: InspectorTab) => void }) {
  const list = useRef<HTMLDivElement>(null);
  return (
    <div
      ref={list}
      className="tabs props-tabs"
      role="tablist"
      aria-label="property groups"
      onKeyDown={(e) => {
        // a clicked tab keeps the focus: the arrows still step the playhead then. shift / ctrl + arrow are timeline keys
        if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey || !focusedByKeyboard()) return;
        const next = arrowTab(tabs, active, e.key);
        if (!next) return;
        // the arrows would also step the playhead. a handled key is marked so the global shortcuts leave it
        e.preventDefault();
        onPick(next);
        requestAnimationFrame(() => list.current?.querySelector<HTMLElement>(`[data-tab="${next}"]`)?.focus());
      }}
    >
      {INSPECTOR_TABS.filter((t) => tabs.includes(t.id)).map((t) => (
        <button
          key={t.id}
          type="button"
          className={`tab${active === t.id ? ' is-active' : ''}`}
          role="tab"
          data-tab={t.id}
          aria-selected={active === t.id}
          tabIndex={active === t.id ? 0 : -1}
          title={t.title}
          onClick={() => onPick(t.id)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
