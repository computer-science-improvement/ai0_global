import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    TanStackRouterVite({ routesDirectory: 'src/routes', autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    // Dev proxy to the automation backend. The backend mounts controllers in
    // TWO groups: some under an `api/` prefix (`api/strategies`,
    // `api/mtproto-sessions`, …) and some at the bare root (`tracking`, `auth`,
    // `settings`, …). The api client modules pass FULL backend paths (API_BASE
    // defaults to ''), so the proxy must forward `/api/*` UNCHANGED — stripping
    // the prefix here turns `/api/strategies` into `/strategies` and 404s
    // ("Cannot GET /strategies"). Each bare-root controller the dashboard calls
    // needs its own entry — and the SAME entry in nginx.conf (prod).
    proxy: Object.fromEntries(
      ['/api', '/auth', '/tracking', '/activity', '/scheduled-posts', '/settings', '/stats', '/r/'].map(
        (prefix) => [prefix, { target: 'http://localhost:3000', changeOrigin: true }],
      ),
    ),
  },
});
