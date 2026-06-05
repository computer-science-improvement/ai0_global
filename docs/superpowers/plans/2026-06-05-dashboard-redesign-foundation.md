# Dashboard Redesign — Foundation + Shell + Placeholders (Phases 1·2·6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-skin the dashboard to the Supabase-dark design language and restructure navigation to a function-first, multi-platform IA (global platform filter + grouped sidebar), with placeholder pages for future areas.

**Architecture:** A token-driven refresh — rewrite the Tailwind v4 `@theme` tokens and the shared component classes in `src/index.css`, so every existing page restyles automatically. Add a small `components/ui/` primitive set + Lucide icons. Replace `Layout`/`Sidebar` with an `AppShell` (grouped sidebar + top bar holding a `PlatformFilter`). Add placeholder routes so the IA is complete.

**Tech Stack:** React 19, TanStack Router (file-based) + Query, Tailwind v4 (`@tailwindcss/vite`), `lucide-react` (new), Inter Variable (already loaded).

**Verification discipline (per spec — no new test framework):** every task ends with `npx tsc --noEmit` (must be clean) and a manual visual smoke in the dev server (`npm run dev`, already running via `nest`/vite). This is pure UI — no backend writes, no publishing, no Claude calls. Compare against the approved mockup in `.superpowers/brainstorm/*/content/supabase-dark.html`.

**Scope note:** Follow-on plans cover Phase 3 (migrate per-page inline styles onto primitives), Phase 4 (Overview widgets + optional `/api/overview`), Phase 5 (Analytics page consolidating `SubsHistoryChart`/`ViewsBarChart`/`EngagementChart`/`RoiPanel`).

---

## File Structure

**Created**
- `src/components/ui/Button.tsx` — button variants (primary/secondary/ghost/tiny).
- `src/components/ui/Badge.tsx` — neutral + semantic status pills.
- `src/components/ui/Card.tsx` — hairline card + `Panel` (card with title).
- `src/components/ui/StatCard.tsx` — KPI tile.
- `src/components/ui/PageHeader.tsx` — page title + subtitle + actions slot.
- `src/components/ui/Placeholder.tsx` — coming-soon empty state.
- `src/components/ui/Icon.tsx` — typed Lucide wrapper (`<Icon name="..."/>`).
- `src/lib/usePlatform.ts` — platform filter state via `?platform=` search param.
- `src/components/PlatformFilter.tsx` — top-bar platform chips.
- `src/components/AppShell.tsx` — sidebar + top bar + `<Outlet/>` (replaces `Layout`).
- `src/components/AppSidebar.tsx` — grouped function-first nav (replaces `Sidebar`).
- `src/routes/analytics.tsx`, `src/routes/calendar.tsx`, `src/routes/settings.tsx`,
  `src/routes/connections.$platform.tsx` — placeholder routes.

**Modified**
- `src/index.css` — `@theme` tokens → Supabase-dark; restyle shared classes.
- `package.json` — add `lucide-react`.
- `src/routes/__root.tsx` — render `AppShell` instead of `Layout`.
- `src/routes/index.tsx` — basic Overview home (PageHeader + placeholder panel).
- `src/components/Layout.tsx`, `src/components/Sidebar.tsx` — deleted (replaced).

---

## Task 1: Supabase-dark design tokens

**Files:**
- Modify: `apps/dashboard/src/index.css` (the `@theme {…}` block + `html, body` + shared component classes)

- [ ] **Step 1: Replace the `@theme` token block**

Open `src/index.css`. Replace the entire existing `@theme { … }` block (the Framer tokens, from `@theme {` through its closing `}`) with:

```css
@theme {
  /* ── Supabase-dark surfaces ─────────────────────────────────────── */
  --color-canvas:        #1b1b1b;
  --color-surface-1:     #202020;  /* sidebar / alt bands */
  --color-surface-2:     #242424;  /* cards, panels */
  --color-surface-3:     #2a2a2a;  /* nested chrome / active nav / row hover */
  --color-hairline:      #2e2e2e;
  --color-hairline-soft: #262626;
  --color-hairline-strong: #3a3a3a;

  /* ── Ink ladder ─────────────────────────────────────────────────── */
  --color-ink:           #ededed;
  --color-ink-muted:     #a0a0a0;
  --color-ink-dim:       #6f6f6f;

  /* ── Single emerald accent ──────────────────────────────────────── */
  --color-accent:        #3ecf8e;
  --color-accent-deep:   #24b47e;  /* pressed */
  --color-on-accent:     #10231a;  /* near-black text ON emerald */

  /* ── Semantic status (functional, not decorative) ──────────────── */
  --color-success:       #3ecf8e;
  --color-success-soft:  rgba(62, 207, 142, 0.14);
  --color-warning:       #ffb224;
  --color-warning-soft:  rgba(255, 178, 36, 0.14);
  --color-danger:        #e5704b;
  --color-danger-soft:   rgba(229, 112, 75, 0.14);

  /* ── Radii — square-ish; 6px buttons ───────────────────────────── */
  --radius-xs:   4px;
  --radius-sm:   6px;
  --radius-md:   8px;
  --radius-lg:   12px;
  --radius-xl:   16px;
  --radius-pill: 9999px;

  /* ── Spacing (8px base) ─────────────────────────────────────────── */
  --space-hair: 1px;
  --space-xxs:  2px;
  --space-xs:   4px;
  --space-sm:   8px;
  --space-md:   12px;
  --space-lg:   16px;
  --space-xl:   24px;
  --space-xxl:  32px;
  --space-section: 64px;
}
```

- [ ] **Step 2: Confirm `html, body` already uses Inter Variable + tabular nums**

The existing `html, body` rule already sets `font-family: 'InterVariable', Inter, …` and `font-variant-numeric: tabular-nums`. Leave it. Keep the `@font-face` for InterVariable. (No change needed — just verify it's still present after your edit.)

- [ ] **Step 3: Restyle the shared component classes to the new tokens**

Find each of these utility classes lower in `index.css` and update their key declarations (keep the selector names — existing pages depend on them):

- `.btn-primary` → `background: var(--color-accent); color: var(--color-on-accent); border-radius: var(--radius-sm); border: none;` and on `:hover` `background: var(--color-accent-deep);`
- `.btn-secondary` → `background: var(--color-surface-2); color: var(--color-ink); border: 1px solid var(--color-hairline-strong); border-radius: var(--radius-sm);`
- `.btn-tiny` / `.btn-tiny-danger` → `border-radius: var(--radius-sm);` tiny stays `background: var(--color-surface-2); border: 1px solid var(--color-hairline);`; danger uses `color: var(--color-danger); border-color: var(--color-danger);`
- `.card` → `background: var(--color-surface-2); border: 1px solid var(--color-hairline); border-radius: var(--radius-md);`
- `.chip` → `background: var(--color-surface-3); color: var(--color-ink-muted); border-radius: var(--radius-pill);` and `.chip-success`/`.chip-danger` use `--color-success-soft`/`--color-danger-soft` backgrounds with the matching solid text color.
- `.input-field` → `background: var(--color-canvas); border: 1px solid var(--color-hairline); border-radius: var(--radius-sm); color: var(--color-ink);` and `:focus` `border-color: var(--color-accent);`
- `.table` rows hover → `background: var(--color-surface-3);`
- `.callout-warning` → background `var(--color-warning-soft)`, border `1px solid var(--color-warning)`.

Leave the typography utility classes (`.text-display-md`, `.text-caption`, etc.) as-is except verify they don't hardcode the old blue accent. If any rule hardcodes `#0099ff`, replace with `var(--color-accent)`.

- [ ] **Step 4: Verify build is clean and smoke the look**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: no output (clean).
Then open the dev server (vite is already running on 5173). Expected: app background is now `#1b1b1b`, buttons are emerald with near-black text, cards have hairline borders. Existing pages (Strategies, Bots) inherit the refresh.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/index.css
git commit -m "feat(dashboard): Supabase-dark design tokens + restyle shared classes"
```

---

## Task 2: Add Lucide + typed Icon wrapper

**Files:**
- Modify: `apps/dashboard/package.json`
- Create: `apps/dashboard/src/components/ui/Icon.tsx`

- [ ] **Step 1: Install lucide-react**

Run: `cd apps/dashboard && npm install lucide-react`
Expected: `lucide-react` appears under `dependencies` in `package.json`.

- [ ] **Step 2: Create the Icon wrapper**

Create `src/components/ui/Icon.tsx`:

```tsx
// Typed Lucide wrapper so call sites use a stable name set and consistent
// default size/stroke. Add new glyphs to ICONS as needed.
import {
  LayoutDashboard, Zap, CalendarClock, Radio, BarChart3, Search, Network,
  Star, Bot, FileText, Plug, Settings, Plus, Pencil, Trash2, RefreshCw,
  Check, X, Play, Pause, Info, TriangleAlert, ChevronLeft, ChevronRight,
  Send, Instagram, Music2, AtSign, Facebook,
  type LucideIcon,
} from 'lucide-react';

const ICONS = {
  overview: LayoutDashboard, strategies: Zap, calendar: CalendarClock,
  channels: Radio, analytics: BarChart3, discovery: Search, graph: Network,
  recommendations: Star, bots: Bot, telegraph: FileText, connections: Plug,
  settings: Settings, plus: Plus, pencil: Pencil, trash: Trash2,
  refresh: RefreshCw, check: Check, x: X, play: Play, pause: Pause,
  info: Info, warning: TriangleAlert, 'chevron-left': ChevronLeft,
  'chevron-right': ChevronRight, telegram: Send, instagram: Instagram,
  tiktok: Music2, threads: AtSign, facebook: Facebook,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 16, className, strokeWidth = 1.75 }: {
  name: IconName; size?: number; className?: string; strokeWidth?: number;
}) {
  const Glyph = ICONS[name];
  return <Glyph size={size} className={className} strokeWidth={strokeWidth} />;
}
```

- [ ] **Step 3: Verify**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/package.json apps/dashboard/package-lock.json apps/dashboard/src/components/ui/Icon.tsx
git commit -m "feat(dashboard): add lucide-react + typed Icon wrapper"
```

---

## Task 3: Button primitive

**Files:**
- Create: `apps/dashboard/src/components/ui/Button.tsx`

- [ ] **Step 1: Create Button**

```tsx
import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'tiny' | 'tiny-danger';

const CLASS: Record<Variant, string> = {
  primary:      'btn-primary',
  secondary:    'btn-secondary',
  ghost:        'btn-ghost',
  tiny:         'btn-tiny',
  'tiny-danger':'btn-tiny-danger',
};

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  children: ReactNode;
}

export function Button({ variant = 'primary', children, className = '', ...rest }: Props) {
  return (
    <button className={`${CLASS[variant]} ${className}`.trim()} {...rest}>
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Add `.btn-ghost` to `index.css`** (if not present)

```css
.btn-ghost {
  background: transparent;
  color: var(--color-ink-muted);
  border: none;
  border-radius: var(--radius-sm);
  padding: 6px 10px;
  font-size: 13px;
  cursor: pointer;
}
.btn-ghost:hover { background: var(--color-surface-3); color: var(--color-ink); }
```

- [ ] **Step 3: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
```bash
git add apps/dashboard/src/components/ui/Button.tsx apps/dashboard/src/index.css
git commit -m "feat(dashboard): Button primitive + btn-ghost"
```

---

## Task 4: Card + Panel primitives

**Files:**
- Create: `apps/dashboard/src/components/ui/Card.tsx`

- [ ] **Step 1: Create Card + Panel**

```tsx
import type { ReactNode, CSSProperties } from 'react';

export function Card({ children, style, className = '' }: {
  children: ReactNode; style?: CSSProperties; className?: string;
}) {
  return <div className={`card ${className}`.trim()} style={style}>{children}</div>;
}

/** Card with a small heading row and an optional right-aligned action. */
export function Panel({ title, action, children, style }: {
  title: string; action?: ReactNode; children: ReactNode; style?: CSSProperties;
}) {
  return (
    <Card style={{ padding: 16, ...style }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h3 className="text-heading-md" style={{ margin: 0, fontSize: 13, fontWeight: 500, letterSpacing: '-0.01em' }}>{title}</h3>
        {action && <div style={{ marginLeft: 'auto' }}>{action}</div>}
      </div>
      {children}
    </Card>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
```bash
git add apps/dashboard/src/components/ui/Card.tsx
git commit -m "feat(dashboard): Card + Panel primitives"
```

---

## Task 5: Badge primitive

**Files:**
- Create: `apps/dashboard/src/components/ui/Badge.tsx`

- [ ] **Step 1: Create Badge**

```tsx
import type { ReactNode } from 'react';

type Tone = 'neutral' | 'success' | 'warning' | 'danger' | 'accent';

const STYLE: Record<Tone, { bg: string; fg: string }> = {
  neutral: { bg: 'var(--color-surface-3)',   fg: 'var(--color-ink-muted)' },
  success: { bg: 'var(--color-success-soft)', fg: 'var(--color-success)' },
  warning: { bg: 'var(--color-warning-soft)', fg: 'var(--color-warning)' },
  danger:  { bg: 'var(--color-danger-soft)',  fg: 'var(--color-danger)' },
  accent:  { bg: 'var(--color-accent)',       fg: 'var(--color-on-accent)' },
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  const s = STYLE[tone];
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      background: s.bg, color: s.fg,
      fontSize: 10, fontWeight: 500, padding: '2px 8px',
      borderRadius: 'var(--radius-pill)', lineHeight: 1.6,
    }}>{children}</span>
  );
}
```

- [ ] **Step 2: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
```bash
git add apps/dashboard/src/components/ui/Badge.tsx
git commit -m "feat(dashboard): Badge primitive (neutral + status tones)"
```

---

## Task 6: StatCard, PageHeader, Placeholder

**Files:**
- Create: `apps/dashboard/src/components/ui/StatCard.tsx`
- Create: `apps/dashboard/src/components/ui/PageHeader.tsx`
- Create: `apps/dashboard/src/components/ui/Placeholder.tsx`

- [ ] **Step 1: StatCard**

```tsx
import type { ReactNode } from 'react';

export function StatCard({ label, value, delta, deltaTone = 'neutral' }: {
  label: string; value: ReactNode;
  delta?: string; deltaTone?: 'up' | 'down' | 'neutral';
}) {
  const color = deltaTone === 'up' ? 'var(--color-success)'
    : deltaTone === 'down' ? 'var(--color-danger)'
    : 'var(--color-ink-muted)';
  return (
    <div className="card" style={{ padding: 14 }}>
      <div style={{ fontSize: 11, color: 'var(--color-ink-muted)' }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 600, letterSpacing: '-0.02em', marginTop: 6 }}>{value}</div>
      {delta && <div style={{ fontSize: 11, marginTop: 4, color }}>{delta}</div>}
    </div>
  );
}
```

- [ ] **Step 2: PageHeader**

```tsx
import type { ReactNode } from 'react';

export function PageHeader({ title, subtitle, actions }: {
  title: string; subtitle?: string; actions?: ReactNode;
}) {
  return (
    <header style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 24 }}>
      <div>
        <h1 className="text-display-md" style={{ margin: 0, fontSize: 24, fontWeight: 500, letterSpacing: '-0.03em' }}>{title}</h1>
        {subtitle && <p className="text-caption" style={{ margin: '6px 0 0', color: 'var(--color-ink-muted)' }}>{subtitle}</p>}
      </div>
      {actions && <div style={{ display: 'flex', gap: 8 }}>{actions}</div>}
    </header>
  );
}
```

- [ ] **Step 3: Placeholder**

```tsx
import type { IconName } from './Icon';
import { Icon } from './Icon';

export function Placeholder({ icon, title, note }: {
  icon: IconName; title: string; note: string;
}) {
  return (
    <div className="card" style={{ textAlign: 'center', padding: 56, color: 'var(--color-ink-muted)' }}>
      <div style={{ display: 'inline-flex', padding: 14, borderRadius: 'var(--radius-pill)', background: 'var(--color-surface-3)', marginBottom: 14 }}>
        <Icon name={icon} size={22} />
      </div>
      <h2 className="text-heading-md" style={{ margin: '0 0 6px', color: 'var(--color-ink)', fontWeight: 500 }}>{title}</h2>
      <p className="text-body-sm" style={{ margin: 0 }}>{note}</p>
      <div style={{ marginTop: 12 }}>
        <span className="chip" style={{ fontSize: 10 }}>Скоро</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
```bash
git add apps/dashboard/src/components/ui/StatCard.tsx apps/dashboard/src/components/ui/PageHeader.tsx apps/dashboard/src/components/ui/Placeholder.tsx
git commit -m "feat(dashboard): StatCard, PageHeader, Placeholder primitives"
```

---

## Task 7: Platform filter state + chips

**Files:**
- Create: `apps/dashboard/src/lib/usePlatform.ts`
- Create: `apps/dashboard/src/components/PlatformFilter.tsx`

- [ ] **Step 1: usePlatform hook**

```tsx
// Global platform filter, persisted in the URL (?platform=). Only Telegram
// has data today; the others are reserved for future integrations.
import { useNavigate, useSearch } from '@tanstack/react-router';

export const PLATFORMS = ['all', 'telegram', 'instagram', 'tiktok', 'threads', 'facebook'] as const;
export type Platform = typeof PLATFORMS[number];

/** Platforms that actually have data / are selectable right now. */
export const ACTIVE_PLATFORMS: Platform[] = ['all', 'telegram'];

export function parsePlatform(raw: unknown): Platform {
  return PLATFORMS.includes(raw as Platform) ? (raw as Platform) : 'all';
}

export function usePlatform(): [Platform, (p: Platform) => void] {
  const search = useSearch({ strict: false }) as Record<string, unknown>;
  const navigate = useNavigate();
  const platform = parsePlatform(search.platform);
  const setPlatform = (p: Platform) =>
    navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, platform: p === 'all' ? undefined : p }) } as any);
  return [platform, setPlatform];
}
```

- [ ] **Step 2: PlatformFilter chips**

```tsx
import { Icon, type IconName } from './ui/Icon';
import { usePlatform, ACTIVE_PLATFORMS, type Platform } from '../lib/usePlatform';

const META: Record<Platform, { label: string; icon?: IconName }> = {
  all:       { label: 'Всі' },
  telegram:  { label: 'Telegram',  icon: 'telegram' },
  instagram: { label: 'Instagram', icon: 'instagram' },
  tiktok:    { label: 'TikTok',    icon: 'tiktok' },
  threads:   { label: 'Threads',   icon: 'threads' },
  facebook:  { label: 'Facebook',  icon: 'facebook' },
};
const ORDER: Platform[] = ['all', 'telegram', 'instagram', 'tiktok', 'threads', 'facebook'];

export function PlatformFilter() {
  const [platform, setPlatform] = usePlatform();
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      {ORDER.map(p => {
        const active = platform === p;
        const enabled = ACTIVE_PLATFORMS.includes(p);
        const meta = META[p];
        return (
          <button
            key={p}
            disabled={!enabled}
            onClick={() => enabled && setPlatform(p)}
            title={enabled ? meta.label : `${meta.label} — скоро`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 12, padding: '5px 11px', borderRadius: 'var(--radius-sm)',
              border: `1px solid ${active ? 'rgba(62,207,142,0.3)' : 'transparent'}`,
              background: active ? 'var(--color-success-soft)' : 'transparent',
              color: active ? 'var(--color-accent)' : enabled ? 'var(--color-ink-muted)' : 'var(--color-ink-dim)',
              cursor: enabled ? 'pointer' : 'not-allowed', opacity: enabled ? 1 : 0.6,
            }}
          >
            {meta.icon && <Icon name={meta.icon} size={13} />}
            {meta.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
```bash
git add apps/dashboard/src/lib/usePlatform.ts apps/dashboard/src/components/PlatformFilter.tsx
git commit -m "feat(dashboard): platform filter state (?platform=) + chips"
```

---

## Task 8: AppSidebar (grouped, function-first)

**Files:**
- Create: `apps/dashboard/src/components/AppSidebar.tsx`

- [ ] **Step 1: Create AppSidebar**

```tsx
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Icon, type IconName } from './ui/Icon';

interface NavItem { to: string; label: string; icon: IconName; soon?: boolean; search?: Record<string, unknown>; }
interface NavGroup { title: string; items: NavItem[]; }

const GROUPS: NavGroup[] = [
  { title: 'Головне', items: [
    { to: '/', label: 'Огляд', icon: 'overview' },
  ]},
  { title: 'Публікація', items: [
    { to: '/strategies', label: 'Стратегії', icon: 'strategies' },
    { to: '/calendar',   label: 'Календар',  icon: 'calendar', soon: true },
    { to: '/channels',   label: 'Мої канали', icon: 'channels', search: { filter: 'mine' } },
  ]},
  { title: 'Аналітика', items: [
    { to: '/analytics', label: 'Статистика', icon: 'analytics' },
  ]},
  { title: 'Інтелідженс', items: [
    { to: '/discovery',       label: 'Discovery',     icon: 'discovery' },
    { to: '/graph',           label: 'Граф',          icon: 'graph' },
    { to: '/recommendations', label: 'Рекомендації',  icon: 'recommendations' },
  ]},
  { title: 'Підключення', items: [
    { to: '/bots',                  label: 'TG-боти',   icon: 'bots' },
    { to: '/telegraph',             label: 'Telegraph', icon: 'telegraph' },
    { to: '/connections/instagram', label: 'Instagram', icon: 'instagram', soon: true },
    { to: '/connections/tiktok',    label: 'TikTok',    icon: 'tiktok', soon: true },
    { to: '/connections/facebook',  label: 'Facebook',  icon: 'facebook', soon: true },
  ]},
  { title: 'Система', items: [
    { to: '/settings', label: 'Налаштування', icon: 'settings', soon: true },
  ]},
];

const COLLAPSED_KEY = 'dashboard:sidebar-collapsed';

export function AppSidebar() {
  const [collapsed, setCollapsed] = useState<boolean>(() =>
    typeof localStorage !== 'undefined' && localStorage.getItem(COLLAPSED_KEY) === '1');
  const toggle = () => setCollapsed(prev => {
    const next = !prev;
    try { localStorage.setItem(COLLAPSED_KEY, next ? '1' : '0'); } catch { /* ignore */ }
    return next;
  });
  const width = collapsed ? 64 : 234;

  return (
    <aside style={{
      width, flexShrink: 0, height: '100vh', position: 'sticky', top: 0,
      background: 'var(--color-surface-1)', borderRight: '1px solid var(--color-hairline)',
      display: 'flex', flexDirection: 'column',
      transition: 'width 160ms cubic-bezier(0.2,0.7,0.2,1)',
    }}>
      <div style={{ padding: '16px 14px 8px' }}>
        <Link to={'/' as any} style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--color-ink)', fontWeight: 600, letterSpacing: '-0.02em', textDecoration: 'none' }}>
          <span style={{ width: 9, height: 9, borderRadius: 999, background: 'var(--color-accent)' }} />
          {!collapsed && <span>ai0</span>}
        </Link>
      </div>

      <nav style={{ flex: 1, overflowY: 'auto', padding: '4px 10px' }}>
        {GROUPS.map(g => (
          <div key={g.title} style={{ marginBottom: 6 }}>
            {!collapsed && (
              <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.09em', color: 'var(--color-ink-dim)', margin: '12px 8px 4px' }}>{g.title}</div>
            )}
            {g.items.map(item => (
              <Link
                key={item.to}
                to={item.to as any}
                search={item.search as any}
                title={collapsed ? item.label : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9,
                  padding: '6px 9px', borderRadius: 'var(--radius-sm)',
                  fontSize: 13, color: 'var(--color-ink-muted)', textDecoration: 'none',
                  justifyContent: collapsed ? 'center' : 'flex-start',
                }}
                activeProps={{ style: { background: 'var(--color-surface-3)', color: 'var(--color-ink)' } }}
              >
                <Icon name={item.icon} size={16} />
                {!collapsed && <span>{item.label}</span>}
                {!collapsed && item.soon && (
                  <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--color-ink-dim)', border: '1px solid var(--color-hairline-strong)', borderRadius: 999, padding: '0 6px' }}>soon</span>
                )}
              </Link>
            ))}
          </div>
        ))}
      </nav>

      <div style={{ padding: '10px' }}>
        <button onClick={toggle} className="btn-secondary" style={{ width: '100%', justifyContent: 'center', gap: 8, fontSize: 12, padding: collapsed ? 8 : '8px 12px' }} title={collapsed ? 'Розгорнути' : 'Згорнути'}>
          <Icon name={collapsed ? 'chevron-right' : 'chevron-left'} size={16} />
          {!collapsed && <span>Згорнути</span>}
        </button>
      </div>
    </aside>
  );
}
```

> Note: TanStack `Link` `activeProps` highlights the current route. The Огляд (`/`) item will only be active on exact `/` (index route is exact by default).

- [ ] **Step 2: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean (will still pass even though routes `/analytics` etc. don't exist yet — `to` is cast `as any`).
```bash
git add apps/dashboard/src/components/AppSidebar.tsx
git commit -m "feat(dashboard): grouped function-first AppSidebar"
```

---

## Task 9: AppShell (sidebar + top bar)

**Files:**
- Create: `apps/dashboard/src/components/AppShell.tsx`
- Modify: `apps/dashboard/src/routes/__root.tsx`

- [ ] **Step 1: Create AppShell**

```tsx
import { Outlet } from '@tanstack/react-router';
import { useAuth } from '../auth/use-auth';
import { authApi } from '../api/auth';
import { AppSidebar } from './AppSidebar';
import { PlatformFilter } from './PlatformFilter';
import { Button } from './ui/Button';
import { Icon } from './ui/Icon';

export function AppShell() {
  const { me, refresh } = useAuth();
  const onLogout = async () => {
    await authApi.logout();
    await refresh();
    window.location.href = '/login';
  };

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: 'var(--color-canvas)' }}>
      <AppSidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 20px', borderBottom: '1px solid var(--color-hairline)',
          background: 'var(--color-canvas)', position: 'sticky', top: 0, zIndex: 10,
        }}>
          <PlatformFilter />
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
            {me && (
              <span className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
                {me.firstName}{me.username ? ` · @${me.username}` : ''}
              </span>
            )}
            <Button variant="primary" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Icon name="plus" size={14} /> Новий пост
            </Button>
            {me && <Button variant="tiny" onClick={onLogout}>Вийти</Button>}
          </div>
        </header>
        <main style={{ flex: 1, padding: '24px 30px 60px', maxWidth: 1320, margin: '0 auto', width: '100%' }}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

> The "Новий пост" CTA is non-wired for now (no onClick) — wiring is a follow-on plan (publishing/calendar). It establishes the emerald CTA per viewport.

- [ ] **Step 2: Point `__root.tsx` at AppShell**

In `src/routes/__root.tsx`, change the import and usage:

```tsx
// was: import { Layout } from '../components/Layout';
import { AppShell } from '../components/AppShell';
```
and in `RootShell`, replace `return <Layout />;` with `return <AppShell />;`.

- [ ] **Step 3: Delete the old shell files**

```bash
git rm apps/dashboard/src/components/Layout.tsx apps/dashboard/src/components/Sidebar.tsx
```

- [ ] **Step 4: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: clean. If TS complains about a leftover import of `Sidebar`/`Layout` elsewhere, grep and remove: `grep -rn "components/Sidebar\|components/Layout" apps/dashboard/src` → fix any hit.
Smoke: app shows the new grouped sidebar + top bar with platform chips + emerald CTA.
```bash
git add apps/dashboard/src/components/AppShell.tsx apps/dashboard/src/routes/__root.tsx
git commit -m "feat(dashboard): AppShell with top bar (platform filter + CTA); drop Layout/Sidebar"
```

---

## Task 10: Overview home + placeholder routes

**Files:**
- Modify: `apps/dashboard/src/routes/index.tsx`
- Create: `apps/dashboard/src/routes/analytics.tsx`
- Create: `apps/dashboard/src/routes/calendar.tsx`
- Create: `apps/dashboard/src/routes/settings.tsx`
- Create: `apps/dashboard/src/routes/connections.$platform.tsx`

- [ ] **Step 1: Overview index route (basic — widgets come in Phase 4)**

Replace the contents of `src/routes/index.tsx` with:

```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/')({ component: OverviewPage });

function OverviewPage() {
  return (
    <div>
      <PageHeader title="Огляд" subtitle="Усі платформи" />
      <Placeholder
        icon="overview"
        title="Зведення скоро"
        note="KPI, найближчі заплановані пости й останні публікації зʼявляться тут (Фаза 4)."
      />
    </div>
  );
}
```

> If the current `index.tsx` redirects elsewhere, this replaces it with a real Overview landing. Verify no other code imports a named export from the old `index.tsx`.

- [ ] **Step 2: Reusable placeholder routes**

`src/routes/analytics.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/analytics')({ component: () => (
  <div>
    <PageHeader title="Статистика" subtitle="Крос-платформна аналітика" />
    <Placeholder icon="analytics" title="Аналітика скоро" note="Зведемо графіки підписників, переглядів, залученості та ROI (Фаза 5)." />
  </div>
)});
```

`src/routes/calendar.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/calendar')({ component: () => (
  <div>
    <PageHeader title="Календар / черга" subtitle="Планування публікацій" />
    <Placeholder icon="calendar" title="Календар скоро" note="Черга та календар запланованих постів." />
  </div>
)});
```

`src/routes/settings.tsx`:
```tsx
import { createFileRoute } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';

export const Route = createFileRoute('/settings')({ component: () => (
  <div>
    <PageHeader title="Налаштування" />
    <Placeholder icon="settings" title="Налаштування скоро" note="Профіль, доступи, глобальні параметри." />
  </div>
)});
```

`src/routes/connections.$platform.tsx`:
```tsx
import { createFileRoute, useParams } from '@tanstack/react-router';
import { PageHeader } from '../components/ui/PageHeader';
import { Placeholder } from '../components/ui/Placeholder';
import type { IconName } from '../components/ui/Icon';

const LABEL: Record<string, { name: string; icon: IconName }> = {
  instagram: { name: 'Instagram', icon: 'instagram' },
  tiktok:    { name: 'TikTok',    icon: 'tiktok' },
  threads:   { name: 'Threads',   icon: 'threads' },
  facebook:  { name: 'Facebook',  icon: 'facebook' },
};

export const Route = createFileRoute('/connections/$platform')({ component: Connection });

function Connection() {
  const { platform } = useParams({ from: '/connections/$platform' });
  const meta = LABEL[platform] ?? { name: platform, icon: 'connections' as IconName };
  return (
    <div>
      <PageHeader title={`Підключення · ${meta.name}`} subtitle="Акаунти та токени" />
      <Placeholder icon={meta.icon} title={`${meta.name} скоро`} note={`Підключення акаунтів ${meta.name} зʼявиться, коли додамо інтеграцію.`} />
    </div>
  );
}
```

- [ ] **Step 3: Verify routes register + build clean**

The TanStack router vite plugin regenerates `src/routeTree.gen.ts` on dev/build. Run: `cd apps/dashboard && npx tsc --noEmit`
Expected: clean. Then smoke each placeholder via the sidebar (Огляд, Календар, Статистика, Налаштування, Instagram/TikTok/Facebook under Підключення) — each renders its placeholder; nav active-state highlights correctly.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/index.tsx apps/dashboard/src/routes/analytics.tsx apps/dashboard/src/routes/calendar.tsx apps/dashboard/src/routes/settings.tsx apps/dashboard/src/routes/connections.\$platform.tsx apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): Overview home + placeholder routes (analytics/calendar/settings/connections)"
```

---

## Task 11: "Мої канали" = owned only

**Files:**
- Modify: `apps/dashboard/src/routes/channels.tsx`

**Context:** The channels page already supports a `filter` search param (`'mine' | 'all'`). The sidebar's "Мої канали" link (Task 8) already passes `search: { filter: 'mine' }`. This task makes `mine` the page's default when no filter is present, so the route is owned-first, and confirms tracked channels are reachable via Discovery.

- [ ] **Step 1: Default the channels filter to `mine`**

In `src/routes/channels.tsx`, find where the `filter` search param is read/defaulted (e.g. `validateSearch` or a `useSearch` default). Change the default value from `'all'` to `'mine'`. If there is a `validateSearch`, set `filter: (search.filter as 'mine'|'all') ?? 'mine'`.

- [ ] **Step 2: Verify + commit**

Run: `cd apps/dashboard && npx tsc --noEmit` → clean.
Smoke: clicking "Мої канали" shows only `is_mine` channels; the page's own filter toggle can still switch to "all". Tracked/competitor channels remain available under Discovery.
```bash
git add apps/dashboard/src/routes/channels.tsx
git commit -m "feat(dashboard): default Channels page to owned (Мої канали)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full type + production build**

Run: `cd apps/dashboard && npm run build`
Expected: `tsc` passes and `vite build` completes with no errors.

- [ ] **Step 2: Visual smoke pass**

In the dev server, verify against `.superpowers/brainstorm/*/content/supabase-dark.html`:
- Sidebar grouped (Головне / Публікація / Аналітика / Інтелідженс / Підключення / Система), collapse works.
- Top bar: platform chips (Всі + Telegram active; IG/TikTok/Threads/Facebook disabled "soon"), emerald "Новий пост" CTA, user + Вийти.
- Emerald appears only on: CTA, active nav/filter, success chips, brand dot. Everything else greyscale.
- All live pages (Strategies, Bots, Telegraph, Discovery, Graph, Recommendations, Channels) render in the new dark theme with no leftover blue accent.
- Placeholders render for Огляд (basic), Календар, Статистика, Налаштування, Connections.

- [ ] **Step 3: Confirm no stale references**

Run: `grep -rn "components/Sidebar\|components/Layout\|#0099ff" apps/dashboard/src`
Expected: no results.

---

## Follow-on plans (not in this plan)
- **Phase 3** — migrate per-page inline styles onto the new `ui/` primitives (Button/Card/Badge/PageHeader) for consistency; replace remaining ad-hoc `Icon` usages with Lucide.
- **Phase 4** — Overview widgets: KPI tiles + week chart + upcoming/recent lists; add a read-only `/api/overview` aggregate if client composition is clumsy.
- **Phase 5** — Analytics page consolidating `SubsHistoryChart`, `ViewsBarChart`, `EngagementChart`, `RoiPanel`, scoped by the platform filter.
