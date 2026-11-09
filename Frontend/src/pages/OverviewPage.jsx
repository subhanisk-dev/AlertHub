import { Category, Metric } from '../components/DashboardWidgets.jsx'
import { categoryColors } from '../services/alertHubApi.js'

// Shows a quick metric snapshot on Overview and detailed charts on Analytics.
export function OverviewPage({ page, analytics, counts, role }) {
  const dailyActivity = analytics?.activity || []
  const dailyPeak = Math.max(1, ...dailyActivity.map(point => point.reported))
  const activityPath = dailyActivity
    .map((point, index) => {
      const x = index * 700 / Math.max(1, dailyActivity.length - 1)
      const y = 160 - point.reported / dailyPeak * 140
      return `${index ? 'L' : 'M'} ${x} ${y}`
    })
    .join(' ')
  const activityFill = `${activityPath} L 700 180 L 0 180 Z`
  const categoryTotal = analytics?.categories?.reduce((sum, item) => sum + item.count, 0) || 0
  let currentAngle = 0
  const categoryGradient = analytics?.categories?.length
    ? `conic-gradient(${analytics.categories.map((item, index) => {
      const start = currentAngle
      currentAngle += item.count / Math.max(1, categoryTotal) * 100
      return `${categoryColors[index % categoryColors.length]} ${start}% ${currentAngle}%`
    }).join(',')})`
    : undefined
  const averageResolution = Number(analytics?.totals?.avg_resolution_minutes || 0)
  const resolutionHint = averageResolution >= 60
    ? `avg ${Math.round(averageResolution / 60)}h to resolve`
    : averageResolution > 0
      ? `avg ${Math.round(averageResolution)} min to resolve`
      : 'resolved and closed incidents'

  return (
    <>
      {page === 'Overview' && <section className="metrics">
        <Metric
          label="Total incidents"
          value={analytics?.totals?.total ?? counts.total}
          hint={role === 'Staff' ? 'assigned to you' : 'in your workspace'}
          icon="▤"
          color="blue"
        />
        <Metric
          label="Needs attention"
          value={analytics?.totals?.pending ?? counts.pending}
          hint="awaiting response"
          icon="◷"
          color="lime"
        />
        <Metric
          label="In progress"
          value={analytics?.totals?.in_progress ?? counts.progress}
          hint="actively being worked"
          icon="↗"
          color="purple"
        />
        <Metric
          label="Resolved / closed"
          value={analytics?.totals
            ? Number(analytics.totals.resolved || 0) + Number(analytics.totals.closed || 0)
            : counts.resolved}
          hint={resolutionHint}
          icon="✓"
          color="green"
        />
      </section>}

      {page === 'Analytics' && <section className="overview-grid">
        <ActivityChart
          activity={dailyActivity}
          peak={dailyPeak}
          line={activityPath}
          fill={activityFill}
          escalations={analytics?.totals?.escalated || 0}
          role={role}
        />
        <CategoryChart
          analytics={analytics}
          counts={counts}
          gradient={categoryGradient}
        />
      </section>}

      {page === 'Analytics' && (
        <section className="panel performance-panel">
          <header className="performance-heading">
            <div className="performance-heading-copy">
              <h2>{role === 'Staff' ? 'My resolution' : 'Team workload'}</h2>
              <p>{role === 'Staff' ? 'Your assigned incidents by status' : 'Incident status by staff member'}</p>
            </div>
          </header>
          {analytics?.staff?.map(member => (
            <div className="performance-row" key={member.id}>
              <span className="assignee-avatar">
                {member.name.split(' ').map(part => part[0]).join('')}
              </span>
              <span className="performance-person">
                <b>{member.name}</b>
                <small>{role === 'Staff' ? 'Assigned work' : 'Staff member'}</small>
              </span>
              <span className="performance-stats" aria-label="Assigned incident status totals">
                {role === 'Admin' && <span className="performance-stat"><b>{member.pending || 0}</b><small>Pending</small></span>}
                <span className="performance-stat"><b>{member.in_progress || 0}</b><small>In progress</small></span>
                <span className="performance-stat"><b>{member.resolved || 0}</b><small>Resolved</small></span>
                <span className="performance-stat"><b>{member.closed || 0}</b><small>Closed</small></span>
              </span>
            </div>
          ))}
        </section>
      )}
    </>
  )
}

// Draws the last month of reports from the API's daily activity series.
function ActivityChart({ activity, peak, line, fill, escalations, role }) {
  return (
    <section className="panel activity-panel">
      <div className="panel-heading">
        <div>
          <h2>Incident activity</h2>
          <p>{role === 'Staff' ? 'Incidents assigned to you in the last 30 days.' : 'Reported issues in the last 30 days.'}</p>
        </div>
      </div>

      <div className="chart-area">
        <div className="chart-y">
          <span>{peak}</span>
          <span>{Math.round(peak / 2)}</span>
          <span>0</span>
        </div>
        <div className="chart">
          <div className="gridlines"><i /><i /><i /><i /><i /></div>
          <svg viewBox="0 0 700 180" preserveAspectRatio="none" aria-label="Incident activity chart">
            <defs>
              <linearGradient id="incident-chart-fill" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0%" stopColor="#e96836" stopOpacity=".24" />
                <stop offset="100%" stopColor="#e96836" stopOpacity="0" />
              </linearGradient>
            </defs>
            {line && (
              <>
                <path d={fill} fill="url(#incident-chart-fill)" />
                <path d={line} fill="none" stroke="#e96836" strokeWidth="3" vectorEffect="non-scaling-stroke" />
              </>
            )}
          </svg>
          <div className="chart-x">
            <span>{activity[0]?.day || '30 days ago'}</span>
            <span>24 days</span>
            <span>18 days</span>
            <span>12 days</span>
            <span>6 days</span>
            <span>Today</span>
          </div>
        </div>
      </div>

      <div className="chart-legend">
        <span><i className="legend-blue" />Reports over time</span>
        <b>{escalations} <small>SLA escalations</small></b>
      </div>
    </section>
  )
}

// Shows category totals and their share in a compact donut chart.
function CategoryChart({ analytics, counts, gradient }) {
  return (
    <section className="panel distribution">
      <div className="panel-heading">
        <div>
          <h2>By category</h2>
          <p>Incident breakdown</p>
        </div>
      </div>

      <div className="donut-wrap">
        <div className="donut" style={gradient ? { background: gradient } : undefined}>
          <div>
            <b>{analytics?.totals?.total ?? counts.total}</b>
            <small>Total</small>
          </div>
        </div>
        <div className="category-list">
          {analytics?.categories?.length
            ? analytics.categories.map((item, index) => (
              <Category
                key={item.category}
                name={item.category}
                count={item.count}
                pct={`${Math.round(item.count / (analytics.totals.total || 1) * 100)}%`}
                color={`c-${index}`}
              />
            ))
            : <span className="category-empty">No incident categories yet</span>}
        </div>
      </div>
    </section>
  )
}
