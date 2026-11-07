import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// Browser output goes in dist/client, served by the host dist/vis-web.mjs
export default defineConfig({
  root: 'src/client',
  plugins: [react()],
  resolve: { dedupe: ['react', 'react-dom'] },
  build: { outDir: '../../dist/client', emptyOutDir: true },
})
