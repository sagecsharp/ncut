import { useEffect, useRef, useState } from 'react';
import { shell } from '../../lib/shell';
import type { McpCopyKind, McpState } from '../../lib/shell';
import { Switch } from '../../features/properties/controls';
import { useMcpCursors } from '../../store/mcpCursors';
import { useUi } from '../../store/ui';
import { mcpAddress, mcpCopyButtons, mcpStatusText } from './mcpText';

/** how long "new token" waits for its second click */
const CONFIRM_MS = 4000;

/** the mcp server of the desktop app: on / off, where it listens, copy the connect text. nothing in a browser. */
export function McpSettings() {
  if (!shell.mcp.available) return null;
  return <McpSettingsInner />;
}

function McpSettingsInner() {
  const [state, setState] = useState<McpState | null>(null);
  const showCursors = useMcpCursors((s) => s.enabled);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    void shell.mcp.state().then((s) => {
      if (alive) setState(s);
    });
    const off = shell.mcp.onState((s) => {
      if (alive) setState(s);
    });
    return () => {
      alive = false;
      off();
      if (timer.current !== null) window.clearTimeout(timer.current);
    };
  }, []);

  if (!state) return null;

  const toggle = (on: boolean) => {
    if (busy) return;
    setBusy(true);
    void shell.mcp
      .setEnabled(on)
      .then((s) => {
        // no answer from the shell: nothing is known to have changed, keep what is shown
        if (s) setState(s);
        else useUi.getState().toast('the app did not answer', 'error');
      })
      .finally(() => setBusy(false));
  };
  const copy = (kind: McpCopyKind) => {
    void shell.mcp.copy(kind).then((done) => useUi.getState().toast(done ? 'copied' : 'could not copy'));
  };
  const disarm = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setConfirming(false);
  };
  const newToken = () => {
    if (!confirming) {
      // every set up client stops working: ask once, with a second click
      setConfirming(true);
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setConfirming(false), CONFIRM_MS);
      return;
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    setConfirming(false);
    void shell.mcp.rotate().then((s) => {
      if (!s) {
        useUi.getState().toast('the app did not answer, the token is unchanged', 'error');
        return;
      }
      setState(s);
      useUi.getState().toast('new token made, set up your clients again');
    });
  };

  const address = mcpAddress(state);
  return (
    <>
      <h3 className="mcp-heading">mcp server</h3>
      <div className="field">
        <span className="field-label">mcp server</span>
        <Switch
          checked={state.enabled}
          title="let claude code and other mcp clients edit the open project. off by default, local only"
          onChange={toggle}
        />
      </div>
      {state.enabled && (
        <>
          {address && (
            <div className="field">
              <span className="field-label">address</span>
              <span className="mono mcp-address" title="the address of the server on this machine">
                {address}
              </span>
            </div>
          )}
          <div className="field">
            <span className="field-label">status</span>
            <span className={`mcp-status${state.error && !state.running ? ' is-error' : ''}`} role="status">
              {mcpStatusText(state)}
            </span>
          </div>
          <div className="mcp-buttons">
            {mcpCopyButtons(state).map((b) => (
              <button key={b.kind} type="button" className="btn btn-sm" title={b.title} onClick={() => copy(b.kind)}>
                {b.label}
              </button>
            ))}
            <button
              type="button"
              className={`btn btn-sm${confirming ? ' btn-primary' : ''}`}
              title="make a new token. every client that was set up stops working"
              onClick={newToken}
              onBlur={disarm}
            >
              {confirming ? 'sure? every client stops working' : 'new token'}
            </button>
          </div>
        </>
      )}
      <p className="mcp-hint">lets claude code and other mcp clients edit the open project. off by default, local only.</p>
      <div className="field">
        <span className="field-label">show cursors</span>
        <Switch
          checked={showCursors}
          title="draw a named cursor over the window where an mcp client works, so you can see what it does. off = no cursors at all"
          onChange={(on) => useMcpCursors.getState().setEnabled(on)}
        />
      </div>
    </>
  );
}
