import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Enables React fast refresh and JSX support in Vite.
export default defineConfig({
  plugins: [react()],
})
