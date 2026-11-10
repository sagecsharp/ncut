import { useCallback, useRef, useState } from 'react';
import { Shrink } from 'lucide-react';
import { useFloatingMenu } from '../timeline/menuBehavior';
import { usePreviewView, zoomTo } from './previewView';
import { percentLabel } from './zoomMath';
import type { Zoom } from './zoomMath';

const CHOICES: ReadonlyArray<{ zoom: Zoom; label: string }> = [
  { zoom: 'fit', label: 'fit' },
  { zoom: 0.5, label: '50%' },
  { zoom: 1, label: '100%' },
  { zoom: 2, label: '200%' },
];

function ZoomMenu({ x, y, onClose }: { x: number; y: number; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const zoom = usePreviewView((s) => s.zoom);
  const pos = useFloatingMenu(ref, x, y, onClose);
  return (
    <div ref={ref} className="menu preview-zoom-menu" style={{ left: pos.x, top: pos.y }} role="menu">
      {CHOICES.map((c) => (
        <button
          key={c.label}
          className="menu-item"
          role="menuitemradio"
          aria-checked={zoom === c.zoom}
          title={c.zoom === 'fit' ? 'fit the whole picture in the panel' : `show the picture at ${c.label}`}
          onClick={() => {
            zoomTo(c.zoom);
            onClose();
          }}
        >
          {c.label}
          {zoom === c.zoom && <span className="menu-hint">on</span>}
        </button>
      ))}
    </div>
  );
}

/** "fit" button and the current zoom in the preview header. click the percent for a menu, double click it to fit again. */
export function ZoomControl() {
  const zoom = usePreviewView((s) => s.zoom);
  const scale = usePreviewView((s) => s.scale);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const close = useCallback(() => setMenu(null), []);
  const fitted = zoom === 'fit';
  return (
    <>
      <button
        className={`icon-btn${fitted ? ' is-active' : ''}`}
        title="fit the whole picture in the panel"
        aria-label="fit to panel"
        aria-pressed={fitted}
        onClick={() => zoomTo('fit')}
      >
        <Shrink size={14} />
      </button>
      <button
        className="btn preview-zoom"
        title={`zoom ${percentLabel(scale)}: click for sizes, double click to fit. ctrl + wheel zooms, middle drag or space + drag moves`}
        aria-label={`zoom ${percentLabel(scale)}`}
        aria-haspopup="menu"
        aria-expanded={menu !== null}
        onClick={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setMenu((m) => (m ? null : { x: r.left, y: r.bottom + 2 }));
        }}
        onDoubleClick={() => {
          setMenu(null);
          zoomTo('fit');
        }}
      >
        {percentLabel(scale)}
      </button>
      {menu && <ZoomMenu x={menu.x} y={menu.y} onClose={close} />}
    </>
  );
}
