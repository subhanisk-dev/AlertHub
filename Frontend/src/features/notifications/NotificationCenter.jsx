import { api } from '../../services/alertHubApi.js';

// Show unread notifications and mark each one read when the member opens it.
export function NotificationCenter({
  open,
  notifications,
  setNotifications,
  incidents,
  openIncident,
  onClose,
  onError,
}) {
  if (!open) return null;

  const openNotification = async notification => {
    try {
      await api(`/api/notifications/${notification.id}`, {
        method: 'PATCH',
        body: '{}',
      });
      setNotifications(previous => previous.filter(item => (
        String(item.id) !== String(notification.id)
      )));

      const incident = incidents.find(item => item.dbId === notification.incident_id);
      if (incident) openIncident(incident);
    } catch (error) {
      onError(error.message);
    }
  };

  return (
    <aside className="notification-popover" aria-label="Notifications">
      <div>
        <b>Notifications</b>
        <button type="button" aria-label="Close notifications" onClick={onClose}>×</button>
      </div>
      {notifications.length ? notifications.map(notification => (
        <button
          className={`notification-item ${notification.read_at ? 'read' : ''}`}
          key={notification.id}
          onClick={() => openNotification(notification)}
        >
          {notification.message}
          <small>{new Date(notification.created_at).toLocaleString()}</small>
        </button>
      )) : <p>You’re all caught up.</p>}
    </aside>
  );
}
