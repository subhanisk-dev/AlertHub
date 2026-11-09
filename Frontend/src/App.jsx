// AlertHub application shell; see ../../docs/PROJECT_GUIDE.md before extending a feature.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import { API_URL, api, getTokenExpiresAt, icons, readSession, socketConnect, statuses, toUiIncident, vapidBytes } from './services/alertHubApi.js';
import { ResolutionNotes } from './components/IncidentDetails.jsx';
import { IncidentTable } from './components/DashboardWidgets.jsx';
import { OverviewPage } from './pages/OverviewPage.jsx';
import { AuthScreen } from './pages/AuthScreen.jsx';
import { PublicStatus } from './pages/PublicStatus.jsx';
import { IncidentListPage } from './pages/IncidentListPage.jsx';
import { MaintenancePage } from './pages/MaintenancePage.jsx';
import { PeoplePage } from './features/people/PeoplePage.jsx';
import { NotificationCenter } from './features/notifications/NotificationCenter.jsx';
import { SettingsPage } from './features/settings/SettingsPage.jsx';

// Merge live notifications by database ID so overlapping socket events and API refreshes cannot duplicate or erase them.
const mergeNotifications = (current, incoming) => {
  const byId = new Map();
  [...incoming, ...current].forEach(item => byId.set(String(item.id), item));
  return [...byId.values()].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 100);
};

function App() {
  // Personalize the landing page using the member's local time and first name.
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';

  // The signed-in member controls which page and incident data are available.
  const [session, setSession] = useState(readSession);
  const [incidents, setIncidents] = useState([]);
  // User accounts open directly on their private incident history.
  const [page, setPage] = useState(() => readSession()?.user?.role === 'user' ? 'My incidents' : 'Overview');
  const [viewMode, setViewMode] = useState('table');
  const [role, setRole] = useState(() => {
    const value = readSession()?.user?.role || 'user';
    return value[0].toUpperCase() + value.slice(1);
  });

  // These filters stay local because the server already returns role-safe records.
  const [filter, setFilter] = useState('All incidents');
  const [categoryFilter, setCategoryFilter] = useState('All categories');
  const [priorityFilter, setPriorityFilter] = useState('All priorities');
  const [staffFilter, setStaffFilter] = useState('All staff');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [query, setQuery] = useState('');
  const [modal, setModal] = useState(false);
  const [selected, setSelected] = useState(null);
  // Let the socket handler read the current incident without reconnecting on panel changes.
  const selectedRef = useRef(selected);
  useLayoutEffect(() => {
    selectedRef.current = selected;
  }, [selected]);
  const [profileMenuOpen, setProfileMenuOpen] = useState(false);
  const [profileModalOpen, setProfileModalOpen] = useState(false);
  const [profileBusy, setProfileBusy] = useState(false);
  const [profileError, setProfileError] = useState('');
  const [profileForm, setProfileForm] = useState({
    name: '',
    email: '',
    currentPassword: '',
    newPassword: '',
    confirmNewPassword: '',
  });

  // Socket references and timers support live updates and the typing indicator.
  const socketRef = useRef(null);
  const typingTimer = useRef(null);
  const typingClear = useRef(null);
  const [typingUser, setTypingUser] = useState('');
  const [toast, setToast] = useState('');

  // Report form fields and optional evidence uploaded with a new incident.
  const [form, setForm] = useState({
    title: '',
    description: '',
    category: 'IT & Network',
    priority: 'Medium',
    location: ''
  });
  const [attachment, setAttachment] = useState(null);

  // Admin pages share these lists for staff, users, and maintenance windows.
  const [users, setUsers] = useState([]);
  const [maintenance, setMaintenance] = useState([]);
  const [statusInfo, setStatusInfo] = useState(null);
  const [analyticsData, setAnalyticsData] = useState(null);
  const [similar, setSimilar] = useState([]);
  const [notifications, setNotifications] = useState([]);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushConfigured, setPushConfigured] = useState(false);
  const [pushSetupMessage, setPushSetupMessage] = useState('Checking browser push setup…');
  const [staff, setStaff] = useState([]);
  const [staffReports, setStaffReports] = useState([]);
  const [apiReady, setApiReady] = useState(false);
  const [socketLive, setSocketLive] = useState(false);
  const [error, setError] = useState('');
  const [authNotice, setAuthNotice] = useState('');
  const notify = useCallback(message => {
    setToast(message);
    window.setTimeout(() => setToast(''), 3000);
  }, []);
  // Sign out locally when an API request reports that the saved token is no longer valid.
  useEffect(() => {
    const handleSessionExpired = () => {
      localStorage.removeItem('alerthub_session');
      setSession(null);
      setNotifications([]);
      setPushEnabled(false);
      setApiReady(false);
      setAuthNotice('Your session expired. Please sign in again.');
    };
    window.addEventListener('alerthub:session-expired', handleSessionExpired);
    return () => window.removeEventListener('alerthub:session-expired', handleSessionExpired);
  }, []);
  // End the active browser session when its signed JWT reaches its expiry time.
  useEffect(() => {
    if (!session?.token) return undefined;
    const expiresAt = getTokenExpiresAt(session.token);
    if (!expiresAt) {
      window.dispatchEvent(new Event('alerthub:session-expired'));
      return undefined;
    }
    const expiryTimer = window.setTimeout(
      () => window.dispatchEvent(new Event('alerthub:session-expired')),
      Math.max(0, expiresAt - Date.now()),
    );
    return () => window.clearTimeout(expiryTimer);
  }, [session?.token]);
  // Load the unread badge as soon as a member signs in, before opening the bell.
  useEffect(() => {
    let active = true;
    if (!session?.token) {
      return undefined;
    }

    api('/api/notifications')
      .then(rows => {
        if (active) setNotifications(rows);
      })
      // Notification loading is optional during page startup; opening the bell reports any API error.
      .catch(() => {});

    return () => {
      active = false;
    };
  }, [session?.token]);
  // Loads the signed-in workspace and listens for server-pushed changes.
  useEffect(() => {
    if (!session?.token) return;
    let alive = true;
    Promise.all([
      api('/api/incidents'),
      session.user.role === 'staff' ? api('/api/incidents?scope=reported') : Promise.resolve([]),
      api('/api/users/staff'),
      api('/api/status/public'),
      session.user.role === 'user' ? Promise.resolve(null) : api('/api/analytics'),
    ]).then(([rows, reportedRows, members, publicStatus, stats]) => {
      if (!alive) return;
      setIncidents(rows.map(item => toUiIncident(item, session.user)));
      setStaffReports(reportedRows.map(item => toUiIncident(item, session.user)));
      setStaff(members);
      setStatusInfo(publicStatus);
      setAnalyticsData(stats);
      setApiReady(true);
      setError('');
      setRole(session.user.role[0].toUpperCase() + session.user.role.slice(1));
    }).catch(err => {
      if (alive) {
        setError(`API connection failed: ${err.message}`);
        setApiReady(false);
      }
    });
    const disconnect = socketConnect(session.token, (event, payload) => {
      if (event === 'notification:new') {
        setNotifications(previous => mergeNotifications(previous, [payload]));
        notify(payload.message || 'You have a new notification');
      }
      if (event === 'notification:removed') {
        const removedIds = new Set((payload.ids || []).map(String));
        setNotifications(previous => previous.filter(item => !removedIds.has(String(item.id))));
      }
      if (event === 'incident:new' || event === 'incident:changed' || event === 'incident:escalated') {
        const mapped = toUiIncident(payload, session.user);
        const isStaffReport = session.user.role === 'staff'
          && Number(payload.reporter_id) === Number(session.user.id);
        if (isStaffReport) {
          setStaffReports(previous => [mapped, ...previous.filter(item => item.dbId !== mapped.dbId)]);
        }
        const assignmentRemoved = session.user.role === 'staff'
          && Number(payload.assigned_to) !== Number(session.user.id);
        if (assignmentRemoved) {
          // Drop removed work from local state immediately instead of waiting for a refetch.
          setIncidents(previous => previous.filter(item => item.dbId !== mapped.dbId));
          setSelected(current => current?.dbId !== mapped.dbId
            ? current
            : isStaffReport ? { ...current, ...mapped } : null);
          if (!isStaffReport) notify('An incident was removed from your assignments');
        } else {
          setIncidents(previous => [mapped, ...previous.filter(item => item.dbId !== mapped.dbId)]);
          setSelected(current => current?.dbId === mapped.dbId
            ? { ...current, ...mapped }
            : current);
          notify(event === 'incident:new' ? 'New incident received live' : 'Incident updated live');
        }
        // Refresh unread items on socket events so the badge stays current without opening it.
        api('/api/notifications').then(rows => setNotifications(previous => mergeNotifications(previous, rows))).catch(() => {});
        // Recalculate scoped counts when an assigned incident changes status or owner.
        if (session.user.role === 'admin' || session.user.role === 'staff') {
          api('/api/analytics').then(setAnalyticsData).catch(() => {});
        }
        if (session.user.role === 'admin') {
          api('/api/admin/users').then(setUsers).catch(() => {});
        }
      }
      if (event === 'comment:new') {
        setSelected(selected => {
          if (selected?.dbId !== payload.incident_id) return selected;
          const existing = selected.comments || [];
          return existing.some(comment => Number(comment.id) === Number(payload.comment.id)) ? selected : {
            ...selected,
            updates: existing.length + 1,
            comments: [...existing, payload.comment]
          };
        });
        notify('New incident discussion update');
        api('/api/notifications').then(rows => setNotifications(previous => mergeNotifications(previous, rows))).catch(() => {});
      }
      if (event === 'staff:presence') setUsers(prev => prev.map(user => user.id === payload.user_id ? {
        ...user,
        online: payload.online
      } : user));
      if (event === 'maintenance:changed') {
        api('/api/status/public').then(setStatusInfo).catch(() => {});
        if (session.user.role === 'admin') {
          api('/api/maintenance').then(setMaintenance).catch(() => {});
        }
      }
      if (event === 'auth:revoked') {
        localStorage.removeItem('alerthub_session');
        setSession(null);
        setNotifications([]);
        setPushEnabled(false);
        setError(payload.reason || 'Please sign in again');
      }
      if (event === 'incident:typing' && selectedRef.current?.dbId === payload.incident_id) {
        setTypingUser(payload.typing ? payload.name : '');
        window.clearTimeout(typingClear.current);
        if (payload.typing) typingClear.current = window.setTimeout(() => setTypingUser(''), 1800);
      }
    }, setSocketLive);
    socketRef.current = disconnect;
    return () => {
      alive = false;
      disconnect.close();
      socketRef.current = null;
      window.clearTimeout(typingClear.current);
    };
  }, [session?.token, session?.user?.id, session?.user, notify]);
  // Show whether this browser already has a push subscription for the current session.
  useEffect(() => {
    let active = true;
    if (!session?.token || !('serviceWorker' in navigator)) {
      return undefined;
    }

    api('/api/push/status')
      .then(status => {
        if (active) {
          setPushEnabled(status.enabled);
          setPushConfigured(status.configured);
          setPushSetupMessage(status.setup_message || '');
        }
      })
      .catch(() => {
        if (active) {
          setPushEnabled(false);
          setPushConfigured(false);
          setPushSetupMessage('Unable to check browser push setup. Confirm the backend is running.');
        }
      });

    return () => {
      active = false;
    };
  }, [session?.token]);
  // Applies search and filters after role-based visibility has been enforced by the API.
  const sessionUserId = session?.user?.id;
  const visible = useMemo(() => incidents.filter(incident => {
    const belongsToRole = role === 'User'
      ? incident.reporter === 'You'
      : role === 'Staff'
        ? incident.assignedId === sessionUserId
        : true;
    const matchesStatus = filter === 'All incidents' || incident.status === filter;
    const matchesCategory = categoryFilter === 'All categories' || incident.category === categoryFilter;
    const matchesPriority = priorityFilter === 'All priorities' || incident.priority === priorityFilter;
    const matchesAssignee = staffFilter === 'All staff' || incident.assigned === staffFilter;
    const matchesDateFrom = !dateFrom || incident.created_at?.slice(0, 10) >= dateFrom;
    const matchesDateTo = !dateTo || incident.created_at?.slice(0, 10) <= dateTo;
    const searchableText = `${incident.title} ${incident.id} ${incident.location} ${incident.assigned}`;
    const matchesSearch = searchableText.toLowerCase().includes(query.toLowerCase());

    return belongsToRole
      && matchesStatus
      && matchesCategory
      && matchesPriority
      && matchesAssignee
      && matchesDateFrom
      && matchesDateTo
      && matchesSearch;
  }), [incidents, role, filter, categoryFilter, priorityFilter, staffFilter, dateFrom, dateTo, query, sessionUserId]);
  // Persists status and assignment updates, then reflects the API response locally.
  const updateIncident = async (id, key, value) => {
    const current = incidents.find(i => i.id === id);
    if (!current?.dbId) return;
    try {
      const payload = key === 'assigned' ? {
        assigned_to: staff.find(s => s.name === value)?.id || null
      } : {
        status: value === 'In progress' ? 'In Progress' : value
      };
      const result = await api(`/api/incidents/${current.dbId}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      const mapped = toUiIncident(result, session.user);
      setIncidents(prev => prev.map(i => i.dbId === mapped.dbId ? mapped : i));
      setSelected(current => current?.dbId === mapped.dbId ? { ...current, ...mapped } : current);
      notify('Incident saved · live update sent');
    } catch (err) {
      setError(err.message);
    }
  };
  // Creates the incident first and stores an optional attachment against its new ID.
  const submit = async e => {
    e.preventDefault();
    try {
      const result = await api('/api/incidents', {
        method: 'POST',
        body: JSON.stringify(form)
      });
      if (attachment) {
        const formData = new FormData();
        formData.append('file', attachment);
        await api(`/api/incidents/${result.id}/attachments`, {
          method: 'POST',
          body: formData
        });
      }
      const mapped = toUiIncident(result, session.user);
      if (role === 'Staff') {
        setStaffReports(previous => [mapped, ...previous.filter(item => item.dbId !== mapped.dbId)]);
      } else {
        // Merge by database ID so the HTTP response and socket event cannot create two rows.
        setIncidents(previous => [mapped, ...previous.filter(item => item.dbId !== mapped.dbId)]);
      }
      notify('Incident reported · admins notified live');
      setModal(false);
      setPage(role === 'Staff' ? 'Reported incidents' : 'My incidents');
      setForm({
        title: '',
        description: '',
        category: 'IT & Network',
        priority: 'Medium',
        location: ''
      });
      setAttachment(null);
      setSimilar([]);
    } catch (err) {
      setError(err.message);
    }
  };
  // Warns reporters when an unresolved report looks similar to their draft.
  const checkSimilar = async () => {
    if (form.title.trim().length > 3) {
      try {
        const params = new URLSearchParams({
          title: form.title,
          location: form.location,
          category: form.category
        });
        setSimilar(await api(`/api/incidents/similar?${params}`));
      } catch {
        setSimilar([]);
      }
    }
  };
  const counts = {
    total: incidents.length,
    pending: incidents.filter(i => i.status === 'Pending').length,
    progress: incidents.filter(i => i.status === 'In progress').length,
    // Count both final states so staff's automatic Closed status appears as completed work.
    resolved: incidents.filter(i => ['Resolved', 'Closed'].includes(i.status)).length
  };
  // Loads the discussion, attachments, and audit history for the selected incident.
  const openIncident = async incident => {
    setSelected(incident);
    if (apiReady && incident.dbId) {
      try {
        const detail = await api(`/api/incidents/${incident.dbId}`);
        setSelected({
          ...toUiIncident(detail, session.user),
          description: detail.description,
          comments: detail.comments,
          audit: detail.audit,
          attachments: detail.attachments
        });
      } catch (err) {
        setError(err.message);
      }
    }
  };
  // Posts a discussion message and keeps the detail panel in sync.
  const addComment = async (incident, message) => {
    if (incident.dbId) {
      try {
        const comment = await api(`/api/incidents/${incident.dbId}/comments`, {
          method: 'POST',
          body: JSON.stringify({
            body: message
          })
        });
        setSelected(current => {
          if (current?.dbId !== incident.dbId) return current;
          const comments = current.comments || [];
          if (comments.some(item => Number(item.id) === Number(comment.id))) return current;
          return {
            ...current,
            updates: comments.length + 1,
            comments: [...comments, comment],
          };
        });
        notify('Comment shared with the incident team');
      } catch (err) {
        setError(err.message);
      }
    }
  };
  // Saves staff resolution notes and updates the incident audit trail.
  const saveResolution = async incident => {
    try {
      const saved = await api(`/api/incidents/${incident.dbId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          resolution_notes: incident.resolution_notes || ''
        })
      });
      const mapped = toUiIncident(saved, session.user);
      setIncidents(prev => prev.map(item => item.dbId === mapped.dbId ? mapped : item));
      setSelected(current => ({
        ...current,
        ...mapped
      }));
      notify('Resolution notes saved to the audit trail');
    } catch (err) {
      setError(err.message);
    }
  };
  // Opens the account editor with the signed-in member's current profile values.
  const editProfile = () => {
    setProfileForm({
      name: session.user?.name || '',
      email: session.user?.email || '',
      currentPassword: '',
      newPassword: '',
      confirmNewPassword: '',
    });
    setProfileError('');
    setProfileMenuOpen(false);
    setProfileModalOpen(true);
  };
  // Saves verified account edits and refreshes the browser's signed-in profile.
  const saveProfile = async event => {
    event.preventDefault();
    if (profileForm.newPassword && profileForm.newPassword !== profileForm.confirmNewPassword) {
      setProfileError('The new passwords do not match.');
      return;
    }

    setProfileBusy(true);
    setProfileError('');
    try {
      const updatedUser = await api('/api/auth/me', {
        method: 'PATCH',
        body: JSON.stringify({
          name: profileForm.name,
          email: profileForm.email,
          current_password: profileForm.currentPassword,
          new_password: profileForm.newPassword,
          new_password_confirmation: profileForm.confirmNewPassword,
        }),
      });
      const updatedSession = { ...session, user: updatedUser };
      localStorage.setItem('alerthub_session', JSON.stringify(updatedSession));
      setSession(updatedSession);
      setProfileModalOpen(false);
      notify(profileForm.newPassword ? 'Password changed successfully' : 'Account details updated');
    } catch (err) {
      setProfileError(err.message);
    } finally {
      setProfileBusy(false);
    }
  };
  // Opens a private attachment only after fetching it with the current token.
  const openAttachment = async id => {
    try {
      const response = await fetch(`${API_URL}/api/attachments/${id}`, {
        headers: {
          Authorization: `Bearer ${session.token}`
        }
      });
      if (!response.ok) throw new Error('Unable to open attachment');
      window.open(URL.createObjectURL(await response.blob()), '_blank', 'noopener,noreferrer');
    } catch (err) {
      setError(err.message);
    }
  };
  // Requests browser permission and registers the VAPID push subscription.
  const enablePush = async () => {
    try {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('Browser push is not supported in this browser');
      const permission = await Notification.requestPermission();
      if (permission !== 'granted') throw new Error('Allow notifications in your browser to enable push');
      const {
        publicKey
      } = await api('/api/push/public-key');
      const registration = await navigator.serviceWorker.register('/sw.js');
      const existingSubscription = await registration.pushManager.getSubscription();
      const subscription = existingSubscription || await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: vapidBytes(publicKey)
      });
      await api('/api/push/subscribe', {
        method: 'POST',
        body: JSON.stringify({
          subscription
        })
      });
      setPushEnabled(true);
      notify('Browser notifications enabled');
    } catch (err) {
      if (err.message === 'Browser push is not configured') {
        setPushConfigured(false);
        setError('');
        return;
      }
      setError(err.message);
    }
  };
  // Removes this browser's push endpoint from MySQL and unsubscribes the device.
  const disablePush = async () => {
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager.getSubscription();
      if (subscription) {
        await api('/api/push/subscribe', {
          method: 'DELETE',
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        await subscription.unsubscribe();
      }
      setPushEnabled(false);
      notify('Browser notifications disabled');
    } catch (err) {
      setError(err.message);
    }
  };
  if (window.location.pathname === '/status') return <PublicStatus />;
  if (!session?.token) return <AuthScreen notice={authNotice} onAuth={value => {
    localStorage.setItem('alerthub_session', JSON.stringify(value));
    setSession(value);
    setPage(value.user?.role === 'user' ? 'My incidents' : 'Overview');
    setAuthNotice('');
    setError('');
  }} />;
  // Shared application frame wraps role-aware navigation and workspace pages.
  return <div className="app-shell">
    <aside className="sidebar">
      <a className="brand" href="#top" onClick={() => setPage(role === 'User' ? 'My incidents' : 'Overview')}><span className="brand-mark">a<span>•</span></span><span className="brand-name">alert<span>hub</span><small>INCIDENT RESPONSE</small></span></a>
      <div className="workspace" aria-label="Current workspace">
        <span className="workspace-icon" aria-hidden="true">{role[0]}</span>
        <span className="workspace-copy">
          <b>AlertHub Workspace</b>
          <small>{role === 'User' ? 'Your incident reports' : `${role} response team`}</small>
        </span>
      </div>
      <p className="nav-label">{role === 'User' ? 'MY REPORTS' : 'WORKSPACE'}</p>
      <nav aria-label={role === 'User' ? 'My incident navigation' : 'Workspace navigation'}>{(role === 'User'
        ? [['My incidents', 'mine']]
        : role === 'Staff'
          ? [['Overview', 'overview'], ['Assigned incidents', 'incidents'], ['Reported incidents', 'mine'], ['Analytics', 'analytics']]
          : [['Overview', 'overview'], ['All incidents', 'incidents'], ['Analytics', 'analytics'], ['People', '◎'], ['Maintenance', '◷']]
      ).map(([name, icon]) => <button key={name} aria-current={page === name ? 'page' : undefined} className={`nav-item ${page === name ? 'active' : ''}`} onClick={async () => {
          setPage(name);
          try {
            if (name === 'People') setUsers(await api('/api/admin/users'));
            if (name === 'Maintenance') setMaintenance(await api('/api/maintenance'));
          } catch (err) {
            setError(err.message);
          }
        }}><span className="nav-icon">{icons[icon] || icon}</span>{name}{role === 'Admin' && name === 'All incidents' && <span className="nav-count" title="Open incidents">{incidents.filter(item => item.status === 'Pending' || item.status === 'In progress').length}</span>}</button>)}</nav>
      <p className="nav-label manage-label">MANAGE</p><button aria-current={page === 'Settings' ? 'page' : undefined} className={`nav-item ${page === 'Settings' ? 'active' : ''}`} onClick={() => setPage('Settings')}><span className="nav-icon">{icons.settings}</span>Settings</button>
      <div className="sidebar-bottom">
        <div className="live-card">
          <div className="live-head"><span className="pulse" /> LIVE SYSTEM STATUS</div>
          <b>All systems operational</b>
          <small>Last checked just now</small>
        </div>
        <div className="profile">
          <span className="avatar">{session.user?.name?.split(' ').map(v => v[0]).join('').slice(0, 2)}</span>
          <span className="profile-identity">
            <b>{session.user?.name}</b>
            <small>{role} · Workspace</small>
          </span>
          <button
            type="button"
            className="profile-menu"
            aria-label="Account options"
            aria-haspopup="menu"
            aria-expanded={profileMenuOpen}
            onClick={() => setProfileMenuOpen(open => !open)}
          >···</button>
          {profileMenuOpen && (
            <div className="profile-popover" role="menu">
              <span>ACCOUNT</span>
              <button type="button" role="menuitem" onClick={editProfile}>Edit profile</button>
            </div>
          )}
        </div>
      </div>
    </aside>
    <main className="main" id="top"><header className="topbar">
        <div className="breadcrumbs" aria-label="Current page">
          <span className="breadcrumb-root">AlertHub</span>
          <span aria-hidden="true">/</span>
          <b>{page}</b>
        </div>
        <div className="top-actions">
          <div className="account-chip" aria-label={`Signed in with ${role} access`}>
            <span>ACCOUNT</span>
            <b>{role}</b>
          </div>
          <span
            className={`connection topbar-connection ${socketLive ? 'online' : ''}`}
            role="status"
            aria-live="polite"
            title={socketLive ? 'Live updates are connected' : 'Connecting to live updates'}
          >
            <i />
            {socketLive ? 'Live' : 'Connecting'}
          </span>
          <button
            className="icon-button notification-button"
            aria-label={`Notifications${notifications.some(item => !item.read_at) ? `, ${notifications.filter(item => !item.read_at).length} unread` : ''}`}
            aria-expanded={notificationOpen}
            onClick={async () => {
              const open = !notificationOpen;
              setNotificationOpen(open);
              if (open) {
                try {
                  setNotifications(await api('/api/notifications'));
                } catch (err) {
                  setError(err.message);
                }
              }
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9" />
              <path d="M10 21h4" />
            </svg>
            {notifications.some(item => !item.read_at) && (
              <span className="notification-count">
                {Math.min(notifications.filter(item => !item.read_at).length, 99)}
              </span>
            )}
          </button>
          <span className="divider" aria-hidden="true" />
          <button className="signout-button" onClick={() => {
            localStorage.removeItem('alerthub_session');
            setSession(null);
            setNotifications([]);
            setPushEnabled(false);
          }}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
              <path d="M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6" />
            </svg>
            <span>Sign out</span>
          </button>
          <button
            type="button"
            className="avatar small-avatar topbar-avatar"
            title="Edit your profile"
            aria-label="Edit your profile"
            onClick={editProfile}
          >
            {session.user?.name?.split(' ').map(part => part[0]).join('').slice(0, 2)}
          </button>
        </div>
      </header>
      <NotificationCenter
        open={notificationOpen}
        notifications={notifications}
        setNotifications={setNotifications}
        incidents={incidents}
        openIncident={openIncident}
        onClose={() => setNotificationOpen(false)}
        onError={setError}
      />
      <div className="content"><div className="page-heading"><div><div className="eyebrow"><span className="pulse" /> {new Intl.DateTimeFormat('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric'
              }).format(new Date()).toUpperCase()}</div><h1>{role === 'User' ? `${greeting}, ${session.user?.name?.split(' ')[0] || 'there'}` : page === 'Overview' ? `${greeting}, ${session.user?.name?.split(' ')[0] || 'there'}` : page}</h1><p>{role === 'User' ? 'Here are your reports and the latest updates from your team.' : page === 'Overview' ? 'Here’s what’s happening across your workspace today.' : page === 'My incidents' || page === 'Reported incidents' ? 'Track the issues you have reported.' : page === 'Assigned incidents' ? 'Review and update incidents assigned to you.' : page === 'Analytics' ? 'A closer look at incident activity and team response.' : page === 'Settings' ? 'Manage your workspace preferences.' : 'Review, assign, and resolve reported issues.'}</p></div>{role !== 'Admin' && <button className="primary-button" onClick={() => setModal(true)}><span>＋</span> Report an incident</button>}</div>
      {statusInfo?.maintenance && <div className="maintenance-banner"><span>◷</span><div><b>Scheduled maintenance: {statusInfo.maintenance.title}</b><small>{statusInfo.maintenance.description} · {new Date(statusInfo.maintenance.starts_at).toLocaleString()} – {new Date(statusInfo.maintenance.ends_at).toLocaleString()}</small></div></div>}
      {/* Overview and analytics display workspace summaries and team activity. */}
      {(page === 'Overview' || page === 'Analytics') && (
        <OverviewPage page={page} analytics={analyticsData} counts={counts} role={role} />
      )}
      {error && <div className="error-banner"><b>!</b>{error}<button onClick={() => setError('')}>Dismiss</button></div>}
      {!apiReady && <div className="error-banner"><b>↻</b>Connecting to AlertHub API…</div>}
      {page === 'Overview' && <div className="panel incident-panel"><div className="panel-heading incident-heading"><div><h2>{role === 'Staff' ? 'My assigned work' : 'Recent incidents'} <span className="live-tag"><i /> LIVE</span></h2><p>{role === 'Staff' ? 'Incidents assigned to you, updated live.' : 'Stay on top of the latest reports and updates.'}</p></div><button className="text-button" onClick={() => setPage(role === 'Staff' ? 'Assigned incidents' : 'All incidents')}>{role === 'Staff' ? 'View assignments' : 'View all incidents'} <span>→</span></button></div><IncidentTable items={visible.slice(0, 4)} role={role} update={updateIncident} open={openIncident} /></div>}
      {/* Incident operations page: search, filter, export, and switch layouts. */}
      {(page === 'All incidents' || page === 'Assigned incidents') && (
        <IncidentListPage
          items={visible}
          role={role}
          staff={staff}
          updateIncident={updateIncident}
          openIncident={openIncident}
          query={query}
          setQuery={setQuery}
          statusFilter={filter}
          setStatusFilter={setFilter}
          categoryFilter={categoryFilter}
          setCategoryFilter={setCategoryFilter}
          priorityFilter={priorityFilter}
          setPriorityFilter={setPriorityFilter}
          staffFilter={staffFilter}
          setStaffFilter={setStaffFilter}
          dateFrom={dateFrom}
          setDateFrom={setDateFrom}
          dateTo={dateTo}
          setDateTo={setDateTo}
          viewMode={viewMode}
          setViewMode={setViewMode}
        />
      )}
      {/* Personal history page: show only the signed-in member's reports. */}
      {(page === 'My incidents' || page === 'Reported incidents') && <div className="panel incident-panel"><div className="panel-heading incident-heading"><div><h2>{role === 'Staff' ? 'Reported incidents' : 'Your reports'}</h2><p>Only incidents you reported appear here. Updates arrive in real time.</p></div>{role !== 'Admin' && <button className="primary-button" onClick={() => setModal(true)}>＋ New report</button>}</div><IncidentTable items={role === 'Staff' ? staffReports : visible} role={role === 'Staff' ? 'User' : role} update={updateIncident} open={openIncident} /></div>}
      {/* People tools live in their own feature component. */}
      {page === 'People' && <PeoplePage users={users} setUsers={setUsers} onError={setError} />}
      {/* Maintenance page: publish service windows and reporting pauses. */}
      {/* Admin page for publishing, editing, and cancelling maintenance windows. */}
      {page === 'Maintenance' && (
        <MaintenancePage
          items={maintenance}
          setItems={setMaintenance}
          notify={notify}
          onError={setError}
        />
      )}
      {page === 'Settings' && (
        <SettingsPage
          socketLive={socketLive}
          pushConfigured={pushConfigured}
          pushSetupMessage={pushSetupMessage}
          pushEnabled={pushEnabled}
          enablePush={enablePush}
          disablePush={disablePush}
        />
      )}
      <footer>© 2026 AlertHub <span>•</span> Built for faster response <span className="footer-right">STATUS <i /> ALL SYSTEMS OPERATIONAL</span></footer></div>
    </main>
    {modal && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setModal(false)}><form className="modal" onSubmit={submit}><div className="modal-head"><div><span className="modal-kicker">NEW REPORT</span><h2>Report an incident</h2><p>Give your team the details they need to help.</p></div><button type="button" className="close" onClick={() => setModal(false)}>×</button></div><label>Incident title<input required maxLength="120" placeholder="e.g. Wi-Fi not working in Lab 2" value={form.title} onChange={e => setForm({
            ...form,
            title: e.target.value
          })} onBlur={checkSimilar} /></label>{similar.length > 0 && <div className="duplicate-warning"><b>Similar open reports</b><small>Check these before submitting a duplicate:</small>{similar.map(item => <span key={item.id}>AH-{String(item.id).padStart(4, '0')} · {item.title} · {item.status}</span>)}</div>}<label>Description<textarea required rows="3" placeholder="What happened? Include any details that might help..." value={form.description} onChange={e => setForm({
            ...form,
            description: e.target.value
          })} /></label><div className="form-row"><label>Category<select value={form.category} onChange={e => setForm({
              ...form,
              category: e.target.value
            })}><option>IT & Network</option><option>Facilities</option><option>Security</option><option>Equipment</option><option>Other</option></select></label><label>Priority<select value={form.priority} onChange={e => setForm({
              ...form,
              priority: e.target.value
            })}><option>Low</option><option>Medium</option><option>High</option><option>Critical</option></select></label></div><label>Location<input required placeholder="Building, floor, or room" value={form.location} onChange={e => setForm({
            ...form,
            location: e.target.value
          })} onBlur={checkSimilar} /></label><label>Photo or document <small>JPG, PNG, WebP, or PDF · up to 8 MB</small><input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={e => setAttachment(e.target.files?.[0] || null)} /></label><div className="modal-foot"><button type="button" className="outline-button" onClick={() => setModal(false)}>Cancel</button><button className="primary-button">Submit report <span>→</span></button></div></form></div>}
    {selected && <div className="modal-backdrop" onMouseDown={e => e.target === e.currentTarget && setSelected(null)}><div className="modal detail-modal"><div className="modal-head"><div><span className="modal-kicker">{selected.id} · {selected.category}</span><h2>{selected.title}</h2><p>{selected.location} · Reported {selected.time} by {selected.reporter}</p></div><button className="close" onClick={() => setSelected(null)}>×</button></div><p className="detail-description">{selected.description}</p><div className="detail-controls"><label>Status<select disabled={role === 'User'} value={selected.status} onChange={e => {
              updateIncident(selected.id, 'status', e.target.value);
              setSelected({
                ...selected,
                status: e.target.value
              });
            }}>{statuses.map(s => <option key={s}>{s}</option>)}</select></label>{role === 'Admin' && <label>Assigned to<select value={selected.assigned} onChange={e => {
              updateIncident(selected.id, 'assigned', e.target.value);
              setSelected({
                ...selected,
                assigned: e.target.value
              });
            }}><option>Unassigned</option>{staff.map(p => <option key={p.id}>{p.name}</option>)}</select></label>}{role === 'User' && <label>Assigned to<span className="assigned-person">{selected.assigned === 'Unassigned' ? 'Not assigned yet' : selected.assigned}</span></label>}</div>{selected.attachments?.length > 0 && <div className="attachment-list"><b>Attachments</b>{selected.attachments.map(file => <button key={file.id} onClick={() => openAttachment(file.id)}>↗ {file.filename} <small>{Math.max(1, Math.round(file.size_bytes / 1024))} KB</small></button>)}</div>}<div className="attachment-add"><label>Add proof or document<input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" onChange={async e => {
              const file = e.target.files?.[0];
              if (!file) return;
              const data = new FormData();
              data.append('file', file);
              try {
                await api(`/api/incidents/${selected.dbId}/attachments`, {
                  method: 'POST',
                  body: data
                });
                const detail = await api(`/api/incidents/${selected.dbId}`);
                setSelected({
                  ...selected,
                  attachments: detail.attachments
                });
                notify('Attachment uploaded');
              } catch (err) {
                setError(err.message);
              }
              e.target.value = '';
            }} /></label></div>{role === 'User' && ['Resolved', 'Closed'].includes(selected.status) && !selected.rating && <div className="rating-box"><b>Was this fixed properly?</b><div>{[1, 2, 3, 4, 5].map(star => <button key={star} onClick={async () => {
              try {
                await api(`/api/incidents/${selected.dbId}/rating`, {
                  method: 'POST',
                  body: JSON.stringify({
                    rating: star
                  })
                });
                setSelected({
                  ...selected,
                  rating: star
                });
                notify('Thanks for your feedback');
              } catch (err) {
                setError(err.message);
              }
            }}>★</button>)}</div></div>}{selected.rating && <div className="rating-box">Your rating: {'★'.repeat(selected.rating)}</div>}{role !== 'User' && <ResolutionNotes incident={selected} onChange={value => setSelected({
          ...selected,
          resolution_notes: value
        })} onSave={saveResolution} />}{role !== 'User' && <details className="audit-details"><summary>Audit trail · {selected.audit?.length || 0} updates</summary>{selected.audit?.map((entry, index) => <div key={index}><b>{entry.actor_name}</b> · {entry.action} — {entry.detail}<small>{entry.created_at}</small></div>)}</details>}<div className="discussion"><h3>{role === 'Admin' ? 'Team discussion' : 'Activity & discussion'} <span>{(selected.comments || []).length}</span></h3>{role === 'Admin' && <small className="discussion-note">Admin messages are visible to staff and admins only.</small>}{(selected.comments || []).map((c, i) => <div className="activity-item" key={c.id || i}><span className="timeline-dot lime-dot" /><span><b>{c.user_name || 'You'}</b> · {c.body || c}<small>{c.created_at ? 'Recent' : 'Just now'}</small></span></div>)}{typingUser && <div className="typing-indicator">{typingUser} is typing…</div>}<form className="comment-form" onSubmit={e => {
            e.preventDefault();
            const v = e.target.elements.comment.value.trim();
            if (v) {
              addComment(selected, v);
              e.target.reset();
            }
          }}><input name="comment" placeholder="Write an update..." onChange={() => {
              if (selected.dbId) {
                socketRef.current?.send('incident:typing', {
                  incident_id: selected.dbId,
                  typing: true
                });
                window.clearTimeout(typingTimer.current);
                typingTimer.current = window.setTimeout(() => socketRef.current?.send('incident:typing', {
                  incident_id: selected.dbId,
                  typing: false
                }), 850);
              }
            }} /><button>Send →</button></form></div></div></div>}
    {profileModalOpen && (
      <div
        className="modal-backdrop"
        onMouseDown={event => event.target === event.currentTarget && setProfileModalOpen(false)}
      >
        <form className="modal profile-edit-modal" onSubmit={saveProfile}>
          <div className="modal-head">
            <div>
              <span className="modal-kicker">ACCOUNT SETTINGS</span>
              <h2>Edit your profile</h2>
              <p>Update your contact details or choose a new password.</p>
            </div>
            <button type="button" className="close" aria-label="Close" onClick={() => setProfileModalOpen(false)}>×</button>
          </div>
          <div className="profile-security-note">
            <span aria-hidden="true">⌑</span>
            <div>
              <b>Confirm it’s you</b>
              <small>Enter your current password to save account changes.</small>
            </div>
          </div>
          <label>
            Full name
            <input
              required
              maxLength="120"
              autoComplete="name"
              autoFocus
              value={profileForm.name}
              onChange={event => setProfileForm({ ...profileForm, name: event.target.value })}
            />
          </label>
          <label>
            Email address
            <input
              required
              type="email"
              maxLength="190"
              autoComplete="email"
              value={profileForm.email}
              onChange={event => setProfileForm({ ...profileForm, email: event.target.value })}
            />
          </label>
          <label>
            Current password <small>Required to save profile changes or change your password.</small>
            <input
              required
              type="password"
              autoComplete="current-password"
              value={profileForm.currentPassword}
              onChange={event => setProfileForm({ ...profileForm, currentPassword: event.target.value })}
            />
          </label>
          <label>
            New password <small>Leave blank if you only want to update your profile.</small>
            <input
              type="password"
              minLength="8"
              autoComplete="new-password"
              value={profileForm.newPassword}
              onChange={event => setProfileForm({ ...profileForm, newPassword: event.target.value })}
            />
          </label>
          <label>
            Confirm new password
            <input
              type="password"
              minLength="8"
              autoComplete="new-password"
              value={profileForm.confirmNewPassword}
              onChange={event => setProfileForm({ ...profileForm, confirmNewPassword: event.target.value })}
            />
          </label>
          {profileError && <div className="auth-error">{profileError}</div>}
          <div className="modal-foot">
            <button type="button" className="outline-button" onClick={() => setProfileModalOpen(false)}>Cancel</button>
            <button className="primary-button" disabled={profileBusy}>
              {profileBusy ? 'Saving…' : 'Save profile'}
            </button>
          </div>
        </form>
      </div>
    )}
    {toast && <div className="toast"><span>✓</span>{toast}</div>}
  </div>;
}
export default App;
