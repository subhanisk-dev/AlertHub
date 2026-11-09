import { useState } from 'react'
import { api } from '../services/alertHubApi.js'

const emptyForm = {
  title: '',
  description: '',
  category: 'IT & Network',
  starts_at: '',
  ends_at: '',
}

// Lets admins create, edit, and cancel public maintenance windows.
export function MaintenancePage({ items, setItems, notify, onError }) {
  const [form, setForm] = useState(emptyForm)
  const [editingId, setEditingId] = useState(null)
  const [saving, setSaving] = useState(false)

  const updateField = (field, value) => {
    setForm(current => ({ ...current, [field]: value }))
  }

  const resetForm = () => {
    setForm(emptyForm)
    setEditingId(null)
  }

  const editWindow = item => {
    setForm({
      title: item.title,
      description: item.description || '',
      category: item.category || '',
      starts_at: item.starts_at.slice(0, 16),
      ends_at: item.ends_at.slice(0, 16),
    })
    setEditingId(item.id)
  }

  const saveWindow = async event => {
    event.preventDefault()
    setSaving(true)
    try {
      const payload = { ...form, category: form.category || null }
      const saved = await api(
        editingId ? `/api/maintenance/${editingId}` : '/api/maintenance',
        {
          method: editingId ? 'PATCH' : 'POST',
          body: JSON.stringify(payload),
        },
      )

      setItems(current => editingId
        ? current.map(item => item.id === saved.id ? saved : item)
        : [saved, ...current])
      notify(editingId ? 'Maintenance window updated' : 'Maintenance window published')
      resetForm()
    } catch (error) {
      onError(error.message)
    } finally {
      setSaving(false)
    }
  }

  const cancelWindow = async item => {
    if (!window.confirm(`Cancel “${item.title}”?`)) return
    try {
      await api(`/api/maintenance/${item.id}`, { method: 'DELETE' })
      setItems(current => current.map(windowItem => windowItem.id === item.id
        ? { ...windowItem, active: false }
        : windowItem))
      notify('Maintenance window cancelled')
      if (editingId === item.id) resetForm()
    } catch (error) {
      onError(error.message)
    }
  }

  return (
    <section className="panel settings-panel maintenance-page">
      <div className="panel-heading">
        <div>
          <h2>Scheduled maintenance</h2>
          <p>Publish service windows and pause reports for affected services.</p>
        </div>
      </div>

      <form className="maintenance-form" onSubmit={saveWindow}>
        <div className="maintenance-form-heading">
          <div>
            <b>{editingId ? 'Edit maintenance window' : 'Schedule a window'}</b>
            <small>{editingId ? 'Saving will publish the updated schedule.' : 'People will see this on the public status page.'}</small>
          </div>
          {editingId && (
            <button type="button" className="text-button" onClick={resetForm}>Cancel editing</button>
          )}
        </div>

        <label>
          Title
          <input
            required
            maxLength="180"
            value={form.title}
            onChange={event => updateField('title', event.target.value)}
            placeholder="Wi-Fi maintenance"
          />
        </label>
        <label>
          Details
          <input
            maxLength="2000"
            value={form.description}
            onChange={event => updateField('description', event.target.value)}
            placeholder="Affected services or locations"
          />
        </label>
        <label>
          Affected category
          <select value={form.category} onChange={event => updateField('category', event.target.value)}>
            <option>IT &amp; Network</option>
            <option>Facilities</option>
            <option>Security</option>
            <option>Equipment</option>
            <option>Other</option>
            <option value="">All categories</option>
          </select>
        </label>

        <div className="form-row">
          <label>
            Starts
            <input
              required
              type="datetime-local"
              value={form.starts_at}
              onChange={event => updateField('starts_at', event.target.value)}
            />
          </label>
          <label>
            Ends
            <input
              required
              type="datetime-local"
              value={form.ends_at}
              onChange={event => updateField('ends_at', event.target.value)}
            />
          </label>
        </div>

        <button className="primary-button" disabled={saving}>
          {saving ? 'Saving…' : editingId ? 'Save changes' : '＋ Schedule window'}
        </button>
      </form>

      <div className="window-list">
        <div className="maintenance-list-heading">
          <b>Maintenance history</b>
          <span>{items.length} {items.length === 1 ? 'window' : 'windows'}</span>
        </div>
        {items.map(item => (
          <article className={`window-item ${item.active ? '' : 'cancelled'}`} key={item.id}>
            <div className="window-item-copy">
              <b>{item.title}</b>
              <span>
                {item.category || 'All categories'} · {new Date(item.starts_at).toLocaleString()}
                {' – '}{new Date(item.ends_at).toLocaleString()}
              </span>
              {item.description && <small>{item.description}</small>}
            </div>
            <div className="window-item-actions">
              <span className={`window-status ${item.active ? 'scheduled' : 'cancelled'}`}>
                {item.active ? 'Scheduled' : 'Cancelled'}
              </span>
              <button type="button" className="outline-button" onClick={() => editWindow(item)}>Edit</button>
              {item.active && (
                <button type="button" className="cancel-window-button" onClick={() => cancelWindow(item)}>
                  Cancel
                </button>
              )}
            </div>
          </article>
        ))}
        {items.length === 0 && <p className="maintenance-empty">No maintenance windows scheduled yet.</p>}
      </div>
    </section>
  )
}
