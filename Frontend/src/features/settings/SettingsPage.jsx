// Present live connection and browser push settings for the workspace.
export function SettingsPage({
  socketLive,
  pushConfigured,
  pushSetupMessage,
  pushEnabled,
  enablePush,
  disablePush,
}) {
  const pushDescription = pushConfigured
    ? 'Get critical updates when this tab is closed.'
    : `${pushSetupMessage || 'Browser push is ready to enable.'} Live in-app notifications remain active.`;
  const pushAction = pushEnabled ? disablePush : enablePush;
  const pushActionLabel = pushEnabled
    ? 'Disable push'
    : pushConfigured ? 'Enable push' : 'Server setup needed';

  return (
    <section className="panel settings-panel">
      <header>
        <h2>Workspace settings</h2>
        <p>AlertHub · Incident response preferences</p>
      </header>

      <div className="setting-row">
        <span>
          <b>Live notifications</b>
          <small>Incident changes arrive instantly while AlertHub is open.</small>
        </span>
        <span className={`connection ${socketLive ? 'online' : ''}`}>
          <i />{socketLive ? 'CONNECTED' : 'DISCONNECTED'}
        </span>
      </div>

      <div className="setting-row">
        <span>
          <b>Browser push notifications</b>
          <small>{pushDescription}</small>
        </span>
        <button
          aria-label={pushActionLabel}
          className="outline-button"
          disabled={!pushConfigured && !pushEnabled}
          onClick={pushAction}
        >
          {pushActionLabel}
        </button>
      </div>

      <a className="status-link" href="/status" target="_blank" rel="noreferrer">
        View public system status →
      </a>
    </section>
  );
}
