import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/hero/',
  server: {
    port: 3099,
  },
  preview: {
    port: 3099,
  },
})
