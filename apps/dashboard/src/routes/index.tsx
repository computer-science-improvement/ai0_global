import { createFileRoute } from '@tanstack/react-router';

// Public marketing landing (no auth). Placeholder — the real design lands in LP-6.
export const Route = createFileRoute('/')({ component: LandingPage });

function LandingPage() {
  return <div style={{ padding: 48, color: 'var(--color-ink)' }}>Landing (placeholder)</div>;
}
