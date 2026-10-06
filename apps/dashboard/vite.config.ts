import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-vite-plugin';
import tailwindcss from '@tailwindcss/vite';
import { devAuthBuildError } from './src/lib/auth-mode';

/**
 * Spec 028 FR-013: a production `vite build` without a sign-in method would ship
 * the dev bypass (a 401 loop against a real backend). Fail the build instead,
 * unless VITE_ALLOW_DEV_AUTH=true. `config.env` holds the VITE_* values from
 * the process env and the .env files, i.e. exactly what gets baked in.
 */
function requireAuthMode(): Plugin {
  return {
    name: 'ai0-require-auth-mode',
    apply: 'build',
    configResolved(config) {
      if (config.mode !== 'production') return;
      const err = devAuthBuildError(config.env as Record<string, string | undefined>);
      if (err) throw new Error(err);
    },
  };
}

export default defineConfig({
  plugins: [
    requireAuthMode(),
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
