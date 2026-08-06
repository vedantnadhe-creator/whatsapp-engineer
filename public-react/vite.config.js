import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

import { reticle } from '@reticlehq/vite-plugin';
export default defineConfig({
  plugins: [reticle(), react()],
  base: '/sessions/',
  build: {
    outDir: '../public',
    emptyOutDir: true,
  },
  server: {
    proxy: {
      '/api': process.env.VITE_API_PROXY || 'http://localhost:18790',
    },
  },
})
