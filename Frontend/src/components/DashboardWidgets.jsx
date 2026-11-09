import { statuses } from '../services/alertHubApi.js'

// Shows one dashboard total with its label and supporting context.
export function Metric({ label, value, delta, hint, icon, color }) {
  return (
    <div className="metric-card">
      <div className="metric-top">
        <span>{label}</span>
        <i className={`metric-icon ${color}`}>{icon}</i>
      </div>
      <div className="metric-value">
        {value}
        <span className={color === 'lime' ? 'lime-delta' : ''}>{delta}</span>
      </div>
      <small>{hint}</small>
    </div>
  )
}

// Displays a category’s count and share beside the analytics chart.
export function Category({ name, count, pct, color }) {
  return (
    <div className="category">
      <span className={color} />
      <span>{name}</span>
      <b>{count}</b>
      <small>{pct}</small>
    </div>
  )
}

// Groups incident cards by status and lets staff update a card in place.
export function IncidentBoard({ items, update, open }) {
  return (
    <div className="kanban">
      {statuses.map(status => {
        const columnItems = items.filter(item => item.status === status)

        return (
          <section className="kanban-column" key={status}>
            <h3>
              {status}
              <span>{columnItems.length}</span>
            </h3>
            {columnItems.map(item => (
              <article
                className="kanban-card"
                key={item.id}
                onClick={() => open(item)}
              >
                <small>
                  {item.id} · {item.category}
                </small>
                <b>{item.title}</b>
                <span>{item.location}</span>
                <div>
                  <span className={`priority ${item.priority.toLowerCase()}`}>
                    <i />
                    {item.priority}
                  </span>
                  <select
                    value={item.status}
                    onClick={event => event.stopPropagation()}
                    onChange={event => update(item.id, 'status', event.target.value)}
                  >
                    {statuses.map(option => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                </div>
              </article>
            ))}
          </section>
        )
      })}
    </div>
  )
}

// Renders searchable incident rows with status controls and assignment details.
export function IncidentTable({ items, role, update, open }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>INCIDENT</th>
            <th>CATEGORY</th>
            <th>PRIORITY</th>
            <th>STATUS</th>
            <th>ASSIGNED TO</th>
            <th>UPDATED</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map(item => (
            <tr key={item.id} onClick={() => open(item)}>
              <td>
                <div className="incident-cell">
                  <span className="incident-id">{item.id}</span>
                  <b>{item.title}</b>
                  <small>{item.location}</small>
                </div>
              </td>
              <td>
                <span className="category-pill">{item.category}</span>
              </td>
              <td>
                <span className={`priority ${item.priority.toLowerCase()}`}>
                  <i />
                  {item.priority}
                </span>
              </td>
              <td>
                <select
                  className={`status-select ${item.status.toLowerCase().replace(' ', '-')}`}
                  value={item.status}
                  onClick={event => event.stopPropagation()}
                  onChange={event => update(item.id, 'status', event.target.value)}
                  disabled={role === 'User'}
                >
                  {statuses.map(status => (
                    <option key={status}>{status}</option>
                  ))}
                </select>
              </td>
              <td>
                <span className="assignee">
                  <span className="assignee-avatar">
                    {item.assigned === 'Unassigned'
                      ? '—'
                      : item.assigned.split(' ').map(word => word[0]).join('').slice(0, 2)}
                  </span>
                  {item.assigned}
                </span>
              </td>
              <td className="time-cell">{item.time}</td>
              <td className="more">···</td>
            </tr>
          ))}
        </tbody>
      </table>

      {items.length === 0 && (
        <div className="empty-state">
          <span>⌕</span>
          <b>No incidents found</b>
          <small>Try changing your search or filters.</small>
        </div>
      )}
    </div>
  )
}
