import { useEffect, useRef, useState } from 'react';
import { shell } from '../../lib/shell';
import type { UpdateState } from '../../lib/shell';
import { clearUserCheck, noteUserCheck } from '../../lib/updateNotice';
import { Switch } from '../../features/properties/controls';
import { useUi } from '../../store/ui';
import { acceptUpdateState, updateButtons, updateStatusText } from './updateText';
import type { UpdateButtonId } from './updateText';

/** how often the "checked 5 min ago" text is worked out again */
const TICK_MS = 30_000;

/** the updater of the desktop app: the version, the automatic switch, check now, restart. nothing in a browser. */
export function UpdateSettings() {
  if (!shell.update.available) return null;
  return <UpdateSettingsInner />;
}

function UpdateSettingsInner() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // counts the events that came in: an answer to a question asked before the last event is older than it
  const events = useRef(0);

  // the answer to a question the page asked (state, check, setAuto). dropped when an event came after the question
  const answered = (asked: number, s: UpdateState) => {
    setState((prev) => acceptUpdateState(prev, s, events.current !== asked));
  };

  useEffect(() => {
    let alive = true;
    const asked = events.current;
    void shell.update.state().then((s) => {
      if (alive) answered(asked, s);
    });
    const off = shell.update.onState((s) => {
      if (!alive) return;
      events.current += 1;
      setState((prev) => acceptUpdateState(prev, s, false));
    });
    const tick = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => {
      alive = false;
      off();
      window.clearInterval(tick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // no updater in this copy (not packaged, not windows): the section does not exist
  if (!state || state.kind === 'none') return null;

  // a shell that did not answer comes out as the "none" state: keep what is shown then, and tell the user
  const take = (asked: number, s: UpdateState) => {
    if (s.kind === 'none') {
      // nothing is going to answer this press later, so a later background failure is not its failure
      clearUserCheck();
      useUi.getState().toast('the app did not answer', 'error');
    } else answered(asked, s);
  };
  const toggle = (on: boolean) => {
    if (busy) return;
    setBusy(true);
    const asked = events.current;
    void shell.update
      .setAuto(on)
      .then((s) => take(asked, s))
      .finally(() => setBusy(false));
  };
  const press = (id: UpdateButtonId) => {
    if (id === 'check') {
      // so a failure of this check is told with a toast (a background one is not)
      noteUserCheck();
      const asked = events.current;
      void shell.update.check().then((s) => take(asked, s));
    } else if (id === 'restart') {
      void shell.update.restart().then((ok) => {
        if (!ok) useUi.getState().toast('no update is ready yet', 'error');
      });
    } else {
      void shell.update.openPage().then((ok) => {
        if (!ok) useUi.getState().toast('could not open the page', 'error');
      });
    }
  };

  return (
    <>
      <h3 className="mcp-heading">updates</h3>
      <div className="field">
        <span className="field-label">version</span>
        <span className="mono update-version">{state.current || 'unknown'}</span>
      </div>
      <div className="field">
        <span className="field-label">update automatically</span>
        <Switch
          checked={state.auto}
          title="check github for a new version and install it when ncut closes. off = ncut never asks on its own"
          onChange={toggle}
        />
      </div>
      <div className="field">
        <span className="field-label">status</span>
        <span className={`mcp-status${state.phase === 'failed' ? ' is-error' : ''}`} role="status">
          {updateStatusText(state, now)}
        </span>
      </div>
      {state.phase === 'downloading' && (
        <div className="update-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(state.progress * 100)}>
          <div className="update-bar-fill" style={{ width: `${Math.round(state.progress * 100)}%` }} />
        </div>
      )}
      <div className="mcp-buttons">
        {updateButtons(state).map((b) => (
          <button
            key={b.id}
            type="button"
            className={`btn btn-sm${b.primary ? ' btn-primary' : ''}`}
            title={b.title}
            disabled={b.disabled}
            onClick={() => press(b.id)}
          >
            {b.label}
          </button>
        ))}
      </div>
      <p className="mcp-hint">asks github once in a while which version is the newest. nothing about you or your projects is sent.</p>
    </>
  );
}
