// Purpose: Render the sign-in and account-registration screens.
// Role: Let users and staff authenticate or create accounts before entering the workspace.
import { useState } from 'react';
import { api } from '../services/alertHubApi.js';

// Let members sign in or create a user or staff account without an email reset workflow.
export function AuthScreen({ onAuth, notice }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [accountRole, setAccountRole] = useState('user');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // Submit only the selected login or registration form and show server errors clearly.
  const submit = async event => {
    event.preventDefault();
    setBusy(true);
    setError('');

    try {
      const session = await api(`/api/auth/${mode}`, {
        method: 'POST',
        body: JSON.stringify({ name, email, password, role: accountRole }),
      });
      onAuth(session);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setBusy(false);
    }
  };

  // Switch between member sign-in and account registration.
  const toggleMode = () => {
    setMode(currentMode => currentMode === 'login' ? 'register' : 'login');
    setError('');
  };

  return (
    <div className="auth-shell">
      <section className="auth-art">
        <div className="auth-brand">
          <span className="brand-mark">a<span>•</span></span>
          <span>alert<span>hub</span></span>
        </div>
        <div className="auth-message">
          <span className="auth-kicker"><i /> INCIDENT RESPONSE, IN REAL TIME</span>
          <h1>When things<br />go wrong,<br /><em>move forward.</em></h1>
          <p>One shared place to report, respond, and get back to what matters.</p>
          <div className="auth-stat">
            <b>01</b>
            <span>Report it.<br /><small>Your team is already on it.</small></span>
          </div>
          <div className="auth-orbit orbit-one" />
          <div className="auth-orbit orbit-two" />
        </div>
        <div className="auth-foot">ALERTHUB · INCIDENT RESPONSE</div>
      </section>

      <section className="auth-side">
        <form className="auth-form" onSubmit={submit}>
          <span className="auth-kicker">YOUR WORKSPACE</span>
          <h2>{mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p>{mode === 'login'
            ? 'Sign in to your incident response workspace.'
            : 'Join your team and report issues.'}</p>
          {notice && <div className="auth-success">{notice}</div>}

          {mode === 'register' && (
            <>
              <label>
                Full name
                <input
                  required
                  autoComplete="name"
                  value={name}
                  onChange={event => setName(event.target.value)}
                  placeholder="Your name"
                />
              </label>
              <label>
                Account type
                <select
                  className="account-type-select"
                  value={accountRole}
                  onChange={event => setAccountRole(event.target.value)}
                >
                  <option value="user">User — report and track incidents</option>
                  <option value="staff">Staff — work on assigned incidents</option>
                </select>
              </label>
            </>
          )}

          <label>
            Work email
            <input
              required
              type="email"
              autoComplete="email"
              value={email}
              onChange={event => setEmail(event.target.value)}
              placeholder="you@organization.com"
            />
          </label>
          <label>
            Password
            <input
              required
              minLength="8"
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="At least 8 characters"
            />
          </label>

          {mode === 'login' && (
            <div className="auth-note">Forgot your password? Contact your workspace administrator.</div>
          )}
          {error && <div className="auth-error">{error}</div>}

          <button aria-label={busy ? 'Please wait' : mode === 'login' ? 'Sign in' : 'Create account'} className="auth-submit" disabled={busy}>
            {busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Create account'}
            <span>→</span>
          </button>
          <div className="auth-switch">
            {mode === 'login' ? 'New to AlertHub?' : 'Already have an account?'}
            <button type="button" aria-label={mode === 'login' ? 'Create an account' : 'Sign in'} onClick={toggleMode}>
              {mode === 'login' ? 'Create an account' : 'Sign in'}
            </button>
          </div>
          {mode === 'register' && (
            <div className="auth-note">
              Choose User or Staff when creating your account. Admin accounts are created separately.
            </div>
          )}
        </form>
      </section>
    </div>
  );
}
