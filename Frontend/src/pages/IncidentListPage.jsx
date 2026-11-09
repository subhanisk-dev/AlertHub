import { IncidentBoard, IncidentTable } from '../components/DashboardWidgets.jsx'
import { statuses } from '../services/alertHubApi.js'

// Provides search, filters, exports, and table/board views for incident work.
export function IncidentListPage({
  items,
  role,
  staff,
  updateIncident,
  openIncident,
  query,
  setQuery,
  statusFilter,
  setStatusFilter,
  categoryFilter,
  setCategoryFilter,
  priorityFilter,
  setPriorityFilter,
  staffFilter,
  setStaffFilter,
  dateFrom,
  setDateFrom,
  dateTo,
  setDateTo,
  viewMode,
  setViewMode,
}) {
  const exportCsv = () => {
    const rows = [
      'ID,Title,Category,Priority,Status,Location',
      ...items.map(item => [
        item.id,
        `"${item.title}"`,
        item.category,
        item.priority,
        item.status,
        `"${item.location}"`,
      ].join(',')),
    ]
    const file = new Blob([rows.join('\n')], { type: 'text/csv' })
    const download = document.createElement('a')

    download.href = URL.createObjectURL(file)
    download.download = 'alerthub-incidents.csv'
    download.click()
    URL.revokeObjectURL(download.href)
  }

  return (
    <section className="panel incident-panel">
      <header className="panel-heading incident-heading">
        <div>
          <h2>{role === 'Staff' ? 'Assigned incidents' : 'All incidents'} <span className="result-count">{items.length}</span></h2>
          <p>{role === 'Staff' ? 'Review and update incidents assigned to you.' : 'Manage reports across your workspace.'}</p>
        </div>
        <button className="outline-button" onClick={exportCsv}>↓ Export CSV</button>
      </header>

      <div className="toolbar">
        <div className="search">
          <span>⌕</span>
          <input
            placeholder="Search incidents..."
            value={query}
            onChange={event => setQuery(event.target.value)}
          />
          <kbd>⌘ K</kbd>
        </div>

        <select className="filter-select" value={statusFilter} onChange={event => setStatusFilter(event.target.value)}>
          {['All incidents', ...statuses].map(status => <option key={status}>{status}</option>)}
        </select>
        <select className="filter-select" value={categoryFilter} onChange={event => setCategoryFilter(event.target.value)}>
          <option>All categories</option>
          <option>IT &amp; Network</option>
          <option>Facilities</option>
          <option>Security</option>
          <option>Equipment</option>
          <option>Other</option>
        </select>

        {role === 'Admin' && (
          <select className="filter-select" value={staffFilter} onChange={event => setStaffFilter(event.target.value)}>
            <option>All staff</option>
            <option>Unassigned</option>
            {staff.map(person => <option key={person.id}>{person.name}</option>)}
          </select>
        )}

        <select className="filter-select" value={priorityFilter} onChange={event => setPriorityFilter(event.target.value)}>
          <option>All priorities</option>
          <option>Critical</option>
          <option>High</option>
          <option>Medium</option>
          <option>Low</option>
        </select>

        <input
          className="date-filter"
          type="date"
          aria-label="From date"
          value={dateFrom}
          onChange={event => setDateFrom(event.target.value)}
        />
        <input
          className="date-filter"
          type="date"
          aria-label="To date"
          value={dateTo}
          onChange={event => setDateTo(event.target.value)}
        />

        <div className="view-switch" aria-label="Incident layout">
          <button className={viewMode === 'table' ? 'selected' : ''} onClick={() => setViewMode('table')}>
            ☷ Table
          </button>
          <button className={viewMode === 'board' ? 'selected' : ''} onClick={() => setViewMode('board')}>
            ▦ Board
          </button>
        </div>
      </div>

      {viewMode === 'table'
        ? <IncidentTable items={items} role={role} update={updateIncident} open={openIncident} />
        : <IncidentBoard items={items} update={updateIncident} open={openIncident} />}
    </section>
  )
}
