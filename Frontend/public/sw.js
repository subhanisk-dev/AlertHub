// Purpose: Handle browser push events while the AlertHub page is not open.
// Role: Show the incident update as a system notification and open the app when selected.
// Displays a background push message when AlertHub is not open.
self.addEventListener('push', event => {
  let payload = {
    title: 'AlertHub',
    body: 'You have a new incident update.',
    url: '/',
  }

  try {
    if (event.data) payload = { ...payload, ...event.data.json() }
  } catch {
    // Keep the default notification when the push payload is not JSON.
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      tag: payload.tag || 'alerthub-update',
      data: { url: payload.url },
    }),
  )
})

// Opens the notification link in the existing AlertHub tab or a new tab.
self.addEventListener('notificationclick', event => {
  event.notification.close()
  let target = new URL(event.notification.data?.url || '/', self.location.origin)
  if (target.origin !== self.location.origin) target = new URL('/', self.location.origin)

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windows => {
      const existing = windows.find(client => client.url.startsWith(self.location.origin))
      if (existing) {
        existing.navigate(target.href)
        return existing.focus()
      }
      return clients.openWindow(target.href)
    }),
  )
})
