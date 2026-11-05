import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { libraryApi } from './vite-plugin-library'

// Keep a stable local URL for the launcher and the browser library API.
export default defineConfig({
  plugins: [react(), libraryApi()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    testTimeout: 15000,
  },
})
