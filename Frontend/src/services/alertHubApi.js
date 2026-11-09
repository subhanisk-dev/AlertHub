import { io } from 'socket.io-client'

// Shared HTTP, session, and realtime helpers used across the frontend.
// Call Flask directly for local use; override this only when the backend has another URL.
export const API_URL = (import.meta.env.VITE_API_URL || 'http://localhost:5000')
  .replace(/\/+$/, '')
const AUTHENTICATION_ERRORS = new Set([
  'Authentication required',
  'Invalid or expired token',
  'Account no longer exists',
])

// Read the JWT expiration time without trusting the browser-side payload for authorization.
export function getTokenExpiresAt(token) {
  try {
    const payload = token.split('.')[1]
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(payload.length / 4) * 4, '=')
    const expiresAt = JSON.parse(atob(base64)).exp
    return Number.isFinite(expiresAt) ? expiresAt * 1000 : null
  } catch {
    return null
  }
}

// Discard invalid or expired sessions before they can trigger repeated unauthorized requests.
export function readSession() {
  try {
    const session = JSON.parse(localStorage.getItem('alerthub_session') || 'null')
    if (!session?.token) return null

    const expiresAt = getTokenExpiresAt(session.token)
    if (!expiresAt || expiresAt <= Date.now()) {
      localStorage.removeItem('alerthub_session')
      return null
    }

    return session
  } catch {
    localStorage.removeItem('alerthub_session')
    return null
  }
}

// Clear a rejected login token and tell the app to return to its sign-in screen.
function expireSession() {
  localStorage.removeItem('alerthub_session')
  window.dispatchEvent(new Event('alerthub:session-expired'))
}

// Sends an API request with the current bearer token and a useful error message.
export async function api(path, options = {}) {
  const session = readSession()
  const isFormData = options.body instanceof FormData
  const headers = {
    ...(!isFormData && { 'Content-Type': 'application/json' }),
    ...(session?.token && { Authorization: `Bearer ${session.token}` }),
    ...options.headers,
  }

  const response = await fetch(`${API_URL}${path}`, { ...options, headers })
  const body = await response.json().catch(() => ({}))

  if (!response.ok) {
    if (response.status === 401 && session?.token && AUTHENTICATION_ERRORS.has(body.error)) {
      expireSession()
    }
    throw new Error(body.error || `Request failed (${response.status})`)
  }

  return body
}

// Opens an authenticated Socket.IO connection and delegates heartbeats and retries to its client.
export function socketConnect(token, onEvent, onConnection) {
  const socket = io(API_URL || window.location.origin, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
    timeout: 10000,
  })

  socket.on('connect', () => onConnection(true))
  socket.on('disconnect', () => onConnection(false))
  socket.on('connect_error', () => onConnection(false))
  socket.onAny((event, ...args) => onEvent(event, args[0]))

  return {
    // Stops the socket and its automatic retries.
    close() {
      socket.disconnect()
    },
    // Sends an application event through the authenticated connection.
    send(event, payload) {
      if (socket.connected) socket.emit(event, payload)
    },
  }
}

// Converts a database incident into the labels and timestamps shown in the UI.
export function toUiIncident(item, user) {
  const ageInMinutes = item.created_at
    ? Math.max(0, Math.floor((Date.now() - new Date(item.created_at).getTime()) / 60000))
    : 0

  return {
    ...item,
    dbId: item.id,
    id: `AH-${String(item.id).padStart(4, '0')}`,
    reporter: item.reporter_id === user?.id ? 'You' : item.reporter_name,
    assigned: item.assignee_name || 'Unassigned',
    assignedId: item.assigned_to,
    updates: item.comments?.length || 0,
    status: item.status === 'In Progress' ? 'In progress' : item.status,
    time: item.created_at
      ? new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-ageInMinutes, 'minute')
      : 'Just now',
  }
}

// Shared labels and palette used by filters, boards, and charts.
export const statuses = ['Pending', 'In progress', 'Resolved', 'Closed']
export const icons = {
  overview: '◫',
  incidents: '▤',
  mine: '◎',
  analytics: '▥',
  settings: '⚙',
}
export const categoryColors = ['#e96836', '#e5a83f', '#a8765c', '#ded3c5', '#bb6843', '#96725c']

// Converts the VAPID public key into bytes for the browser Push API.
export function vapidBytes(value) {
  const base64 = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=')

  return Uint8Array.from(atob(base64), character => character.charCodeAt(0))
}
