import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: { host: true, port: 5173 },
  build: {
    target: 'es2020',
    // Field reps are on cellular. Split the admin/desktop-only weight out of the
    // field-rep critical path so the phone bundle stays small.
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return
          // Routing changes far more often than the runtime; keeping it separate
          // means a routing-only deploy doesn't invalidate the big React chunk
          // in a rep's cache.
          if (id.includes('react-router') || id.includes('@remix-run')) return 'router'
          return 'vendor'
        },
      },
    },
  },
})
