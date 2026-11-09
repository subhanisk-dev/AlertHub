import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Enables React fast refresh and JSX support in Vite.
export default defineConfig({
  plugins: [react()],
  // Keep local frontend requests on port 5173 while forwarding API and WebSocket traffic to Flask.
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:5000',
      '/socket.io': {
        target: 'http://127.0.0.1:5000',
        ws: true,
      },
    },
  },
})
