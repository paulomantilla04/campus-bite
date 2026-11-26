import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(),],
  server: {
    // Mismas rutas /api/* que el gateway Nginx en Docker/Dokploy.
    proxy: {
      '/api/menu': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/menu/, ''),
      },
      '/api/orders': {
        target: 'http://localhost:3002',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/orders/, ''),
      },
      '/api/notifications/stream': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/notifications\/stream/, '/notifications/stream'),
      },
      '/api/notifications': {
        target: 'http://localhost:3003',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/notifications/, ''),
      },
    },
  },
})
