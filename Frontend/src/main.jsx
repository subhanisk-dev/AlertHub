// Purpose: Mount the React application into the browser document.
// Role: Load global styles and enable StrictMode checks around the AlertHub shell.
// Browser entry point: mount the AlertHub app with React strict checks enabled.
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
