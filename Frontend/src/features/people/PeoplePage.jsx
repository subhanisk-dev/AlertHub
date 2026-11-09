import { useState } from 'react';
import { api } from '../../services/alertHubApi.js';

// Manage member roles and account access while showing staff workload totals.
export function PeoplePage({ users, setUsers, onError }) {
  const [roleFilter, setRoleFilter] = useState('all');
  const [accountFilter, setAccountFilter] = useState('all');

  const visiblePeople = users.filter(user => {
    const matchesRole = roleFilter === 'all' || user.role === roleFilter;
    const matchesAccount = accountFilter === 'all'
      || (accountFilter === 'blocked' ? user.blocked : !user.blocked);
    return matchesRole && matchesAccount;
  });

  const updateMember = async (userId, changes) => {
    try {
      const updated = await api(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(changes),
      });
      setUsers(previous => previous.map(member => (
        member.id === updated.id ? { ...member, ...updated } : member
      )));
    } catch (error) {
      onError(error.message);
    }
  };

  return (
    <section className="panel settings-panel">
      <header className="panel-heading">
        <div>
          <h2>People & access</h2>
          <p>Manage workspace roles, account access, and incident activity.</p>
        </div>
      </header>

      <div className="people-filters" aria-label="People filters">
        <select
          className="filter-select people-filter"
          aria-label="Filter people by role"
          value={roleFilter}
          onChange={event => setRoleFilter(event.target.value)}
        >
          <option value="all">All roles</option>
          <option value="user">Users</option>
          <option value="staff">Staff</option>
          <option value="admin">Admins</option>
        </select>
        <select
          className="filter-select people-filter"
          aria-label="Filter by account access"
          value={accountFilter}
          onChange={event => setAccountFilter(event.target.value)}
        >
          <option value="all">All accounts</option>
          <option value="active">Active accounts</option>
          <option value="blocked">Blocked accounts</option>
        </select>
      </div>

      <div className="user-list">
        {visiblePeople.length ? visiblePeople.map(user => (
          <article className="user-row" key={user.id}>
            <span className="assignee-avatar">
              {user.name.split(' ').map(part => part[0]).join('').slice(0, 2)}
            </span>
            <span className="user-identity">
              <b>{user.name}</b>
              <small>{user.email}</small>
              <small className={`staff-presence ${user.online ? 'online' : 'offline'}`}>
                {user.role === 'staff' ? user.online ? '● Online' : '○ Offline' : user.role}
              </small>
              {user.role === 'staff' && (
                <span className="people-incident-counts">
                  <span>In progress {user.in_progress_count}</span>
                  <span>Resolved {user.resolved_count}</span>
                  <span>Closed {user.closed_count}</span>
                </span>
              )}
            </span>

            <select
              aria-label={`Role for ${user.name}`}
              value={user.role}
              onChange={event => updateMember(user.id, { role: event.target.value })}
            >
              <option value="user">User</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>

            <div className="people-access-control">
              <span className={`account-status ${user.blocked ? 'blocked' : 'active'}`}>
                {user.blocked ? 'Blocked' : 'Active'}
              </span>
              <label className="block-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(user.blocked)}
                  aria-label={`Block ${user.name}`}
                  onChange={event => updateMember(user.id, { blocked: event.target.checked })}
                />
                Block
              </label>
            </div>
          </article>
        )) : <p className="people-empty">No people match these filters.</p>}
      </div>
    </section>
  );
}
