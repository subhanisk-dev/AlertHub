// Purpose: Render public service health and scheduled maintenance information.
// Role: Let visitors check system status without signing into AlertHub.
import { useEffect, useState } from 'react'
import { api } from '../services/alertHubApi.js'

// Shows service health and planned maintenance without requiring an account.
export function PublicStatus() {
  const [data, setData] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    api('/api/status/public')
      .then(setData)
      .catch(requestError => setError(requestError.message))
  }, [])

  return (
    <main className="public-status">
      <a href="/" className="public-brand">
        <span className="brand-mark">a<span>•</span></span>
        alert<span>hub</span>
      </a>

      <span className="auth-kicker">ALERTHUB · LIVE STATUS</span>
      <h1>Service status</h1>
      <p>Current health across the systems that keep your campus moving.</p>

      {error && <div className="auth-error">Status service unavailable · {error}</div>}
      {!error && !data && <p>Checking systems…</p>}

      {data && (
        <>
          <div className={`status-summary ${data.status === 'operational' ? 'is-good' : 'is-maintenance'}`}>
            <i />
            {data.status === 'operational'
              ? 'All systems operational'
              : 'Scheduled maintenance in progress'}
          </div>

          <div className="status-grid">
            <div>
              <small>OPEN INCIDENTS</small>
              <b>{data.counts.active || 0}</b>
            </div>
            <div>
              <small>RESOLVED</small>
              <b>{data.counts.resolved || 0}</b>
            </div>
            <div>
              <small>TOTAL REPORTED</small>
              <b>{data.counts.total || 0}</b>
            </div>
          </div>

          {data.maintenance && (
            <section className="status-maintenance">
              <b>{data.maintenance.title}</b>
              <p>
                {data.maintenance.description || 'Scheduled service maintenance'}
                {' · '}{data.maintenance.category || 'All categories'}
              </p>
              <small>
                {new Date(data.maintenance.starts_at).toLocaleString()}
                {' – '}
                {new Date(data.maintenance.ends_at).toLocaleString()}
              </small>
            </section>
          )}
        </>
      )}

      <a className="status-back" href="/">← Back to AlertHub</a>
    </main>
  )
}
