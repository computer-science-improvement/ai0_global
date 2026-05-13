import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    TanStackRouterVite({ routesDirectory: 'src/routes' }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    proxy: {
      '/api':  { target: 'http://localhost:3000', changeOrigin: true, rewrite: (p) => p.replace(/^\/api/, '') },
      '/auth': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
