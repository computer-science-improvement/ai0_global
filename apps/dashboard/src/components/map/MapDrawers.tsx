import { useEffect, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Icon, type IconName } from '../ui/Icon';
import { Badge } from '../ui/Badge';
import type { MapAlert, MapResource, MapRoad, MapSnapshot, MapUnit } from '../../api/map';
import {
  HEALTH_META, PLATFORM_META, ROAD_META, STATE_META, ago, alertTone, compactNumber, kindLabel, levelLine, modeLabel, resourceTitle, usd,
} from '../../lib/map-state';
import { parseNavTarget } from '../../nav/config';
import { Avatar, UnitFace } from './MapAvatar';

// Spec 056 FR-003: the drawers behind a click — a building, a unit, a road, the list of what waits for the owner.
// On a phone (< 640 px) the CSS turns them into bottom sheets.

export function MapDrawer({ title, subtitle, lead, onClose, children }: {
  title: string; subtitle?: ReactNode; lead?: ReactNode; onClose: () => void; children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.modal-backdrop')) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <aside className="map-hud map-drawer" role="dialog" aria-label={title}>
      <div className="map-drawer-grip" aria-hidden />
      <div className="map-drawer-head">
        {lead}
        <div style={{ minWidth: 0, flex: 1 }}>
          <h2 className="text-body" style={{ margin: 0, fontWeight: 600, overflowWrap: 'anywhere' }}>{title}</h2>
          {subtitle && <div className="text-micro" style={{ marginTop: 4, color: 'var(--color-ink-muted)', display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{subtitle}</div>}
        </div>
        <button type="button" className="map-icon-btn" aria-label="Close" onClick={onClose}><Icon name="x" size={16} /></button>
      </div>
      <div className="map-drawer-body">{children}</div>
    </aside>
  );
}

function Facts({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="map-facts">
      {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (<div key={k} style={{ display: 'contents' }}><dt>{k}</dt><dd>{v}</dd></div>))}
    </dl>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-caption" style={{ margin: '0 0 8px', color: 'var(--color-ink-muted)', fontWeight: 600 }}>{title}</h3>
      {children}
    </section>
  );
}

const LinkChip = ({ icon, children, ...rest }: { icon: IconName; children: ReactNode } & Record<string, unknown>) => (
  <Link {...(rest as any)} className="map-link"><Icon name={icon} size={14} />{children}</Link>
);

/** The Connections page section that manages each platform. */
const CONNECTION_SECTION: Record<MapResource['platform'], 'telegram' | 'meta' | 'tiktok'> = { telegram: 'telegram', instagram: 'meta', facebook: 'meta', threads: 'meta', tiktok: 'tiktok', youtube: 'telegram' };

const ALERT_ICON: Record<string, IconName> = { approval: 'check', connection: 'connections', directive: 'agents', launch: 'rocket', stuck: 'warning', budget: 'spend' };

function useGo() {
  const navigate = useNavigate();
  return (path: string) => {
    const t = parseNavTarget(path);
    if (t) void navigate({ to: t.to as never, search: (t.search ?? {}) as never });
  };
}

function AlertRows({ alerts, onShow }: { alerts: MapAlert[]; onShow?: (ref: string) => void }) {
  const go = useGo();
  if (!alerts.length) return <p className="text-caption" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>Nothing waits for you here.</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {alerts.map((a, i) => (
        <div key={`${a.kind}-${a.ref}-${a.agent}-${i}`} className="map-alert-row" style={{ cursor: 'default', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <span style={{ color: alertTone(a.kind) === 'danger' ? 'var(--color-danger)' : 'var(--color-warning)', flex: 'none', marginTop: 1 }}><Icon name={ALERT_ICON[a.kind] ?? 'warning'} size={16} /></span>
            <span style={{ flex: 1 }}>{a.title}</span>
            <Badge tone={alertTone(a.kind) === 'danger' ? 'danger' : 'warning'}>{a.count}</Badge>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" className="btn-tiny" onClick={() => go(a.path)}>Open</button>
            {a.ref && onShow && <button type="button" className="btn-tiny" onClick={() => onShow(a.ref!)}>Show on the map</button>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AlertsDrawer({ snap, onClose, onShow }: { snap: MapSnapshot; onClose: () => void; onShow: (ref: string) => void }) {
  return (
    <MapDrawer title="Waiting for you" subtitle={snap.alerts.length ? `${snap.alerts.reduce((s, a) => s + a.count, 0)} in ${snap.alerts.length} places` : 'All clear'} onClose={onClose}>
      <AlertRows alerts={snap.alerts} onShow={onShow} />
    </MapDrawer>
  );
}

function StateChip({ unit }: { unit: Pick<MapUnit, 'state'> }) {
  const st = STATE_META[unit.state];
  return <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: st.color, fontWeight: 600 }}><Icon name={st.icon} size={13} strokeWidth={2.6} />{st.label}</span>;
}

export function BuildingDrawer({ snap, res, onClose, onPickUnit, onShow }: {
  snap: MapSnapshot; res: MapResource; onClose: () => void; onPickUnit: (id: string) => void; onShow: (ref: string) => void;
}) {
  const meta = PLATFORM_META[res.platform];
  const health = HEALTH_META[res.health];
  const network = snap.networks.find((n) => n.id === res.groupId);
  const here = snap.units.filter((u) => u.homeRef === res.ref && u.parentId == null);
  const alerts = snap.alerts.filter((a) => a.ref === res.ref);
  const roads = snap.roads.filter((r) => r.from === res.ref || r.to === res.ref);
  return (
    <MapDrawer
      title={resourceTitle(res)}
      lead={<span style={{ width: 38, height: 38, borderRadius: 10, display: 'grid', placeItems: 'center', background: 'var(--color-surface-3)', color: meta.tint, border: `2px solid ${health.color}`, flex: 'none' }}><Icon name={meta.icon} size={20} /></span>}
      subtitle={<><span>{meta.label}</span><Badge tone={res.health === 'ok' ? 'success' : res.health === 'warning' ? 'warning' : res.health === 'broken' ? 'danger' : 'neutral'}>{health.label}</Badge>{res.paused && <Badge tone="neutral">Paused</Badge>}</>}
      onClose={onClose}
    >
      <Facts rows={[
        ['Network', network?.name ?? 'Frontier (no network)'],
        ['Followers', res.followers != null ? compactNumber(res.followers) : null],
        ['Posts today', String(res.postsToday)],
        ['Waiting for you', res.waiting ? `${res.waiting} ${res.waiting === 1 ? 'post' : 'posts'} to approve` : 'Nothing'],
        ['Connection', res.healthDetail],
        ['Run by', res.agent ? `@${res.agent}` : 'No agent yet'],
      ]} />
      <Section title="Waiting here"><AlertRows alerts={alerts} /></Section>
      {here.length > 0 && (
        <Section title="Agents">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {here.map((u) => (
              <button key={u.id} type="button" className="map-alert-row" onClick={() => onPickUnit(u.id)} style={{ alignItems: 'center' }}>
                <Avatar handle={u.handle} kind={u.kind} size={24} />
                <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>@{u.handle}{u.level != null && <span className="text-micro" style={{ color: 'var(--color-ink-muted)' }}> · Lv {u.level}</span>}</span><StateChip unit={u} />
              </button>
            ))}
          </div>
        </Section>
      )}
      {roads.length > 0 && <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>{roads.length} {roads.length === 1 ? 'road' : 'roads'} connect this building to others: click one on the map.</p>}
      <div className="map-links">
        {res.agent && <LinkChip icon="agents" to="/app/agents/$handle" params={{ handle: res.agent }}>Agent page</LinkChip>}
        <LinkChip icon="check" to="/app/agents/inbox" search={{ tab: 'approvals' }}>Approvals</LinkChip>
        <LinkChip icon="connections" to="/app/connections" search={{ section: CONNECTION_SECTION[res.platform] }}>Connections</LinkChip>
        <button type="button" className="map-link" onClick={() => onShow(res.ref)}><Icon name="fit" size={14} />Center</button>
      </div>
    </MapDrawer>
  );
}

export function UnitDrawer({ snap, unit, onClose, onPickBuilding }: { snap: MapSnapshot; unit: MapUnit; onClose: () => void; onPickBuilding: (ref: string) => void }) {
  const st = STATE_META[unit.state];
  const home = snap.resources.find((r) => r.ref === unit.homeRef);
  const parent = unit.parentId ? snap.units.find((u) => u.id === unit.parentId) : null;
  const pct = unit.capUsd ? Math.min(100, (unit.spentTodayUsd / unit.capUsd) * 100) : null;
  return (
    <MapDrawer
      title={unit.name}
      lead={
        <svg width="46" height="46" viewBox="-23 -23 46 46" aria-hidden style={{ flex: 'none' }}>
          <circle r="20" fill="none" strokeWidth="3" style={{ stroke: st.color }} />
          <circle r="17.5" style={{ fill: 'var(--color-surface-2)' }} />
          <g transform="scale(1.6)"><UnitFace unit={unit} /></g>
          {unit.emoji && (
            <g transform="translate(13 14)">
              <circle r="8.5" style={{ fill: 'var(--color-surface-2)', stroke: 'var(--color-hairline-strong)' }} />
              <text textAnchor="middle" dominantBaseline="central" fontSize="10">{unit.emoji}</text>
            </g>
          )}
        </svg>
      }
      subtitle={<><span>@{unit.handle}</span><span>·</span><span>{kindLabel(unit.kind)}</span>{unit.level != null && <Badge tone="accent">Lv {unit.level}</Badge>}</>}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div className="text-body-sm"><StateChip unit={unit} /></div>
        <div className="text-caption" style={{ color: 'var(--color-ink-muted)' }}>
          {unit.detail ? `${unit.detail}${unit.stateSince ? ` · since ${ago(unit.stateSince)}` : ''}` : unit.stateSince ? `since ${ago(unit.stateSince)}` : st.help}
        </div>
      </div>
      <Facts rows={[
        ['Mode', unit.effectiveMode === unit.mode ? modeLabel(unit.mode) : `${modeLabel(unit.effectiveMode)} (the channel card; the agent is set to ${modeLabel(unit.mode).toLowerCase()})`],
        ['Spend today', <span key="s" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span>{usd(unit.spentTodayUsd)}{unit.capUsd != null && <span style={{ color: 'var(--color-ink-muted)' }}> of {usd(unit.capUsd)} cap</span>}</span>
          {pct != null && <span className={`map-meter${pct >= 90 ? ' is-danger' : pct >= 70 ? ' is-warning' : ''}`} style={{ width: '100%' }}><i style={{ width: `${pct}%` }} /></span>}
        </span>],
        ['Runs today', String(unit.runsToday)],
        ['Last run', unit.lastRunAt ? ago(unit.lastRunAt) : 'No runs yet'],
        ['Stands at', home ? <button key="h" type="button" className="link-accent" style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', font: 'inherit' }} onClick={() => onPickBuilding(home.ref)}>{resourceTitle(home)}</button> : 'Headquarters'],
        ['Works for', parent ? `@${parent.handle}` : null],
        ['Level', unit.level != null ? `${unit.level} of 10${unit.level < 10 && unit.levelStats ? ` · score ${unit.levelStats.score}, the next level at ${unit.level * 10}` : ''}` : null],
      ]} />
      {unit.levelStats && (
        <p className="text-micro" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>
          {parent ? `Same as @${parent.handle}. ` : ''}Level counts quality, not volume: {levelLine(unit.levelStats)}.
        </p>
      )}
      <div className="map-links">
        <LinkChip icon="agents" to="/app/agents/$handle" params={{ handle: unit.handle }}>Agent page</LinkChip>
        <LinkChip icon="layers" to="/app/agents/$handle" params={{ handle: unit.handle }} search={{ tab: 'artifacts' }}>Artifacts</LinkChip>
        <LinkChip icon="wrench" to="/app/agents/$handle" params={{ handle: unit.handle }} search={{ tab: 'loadout' }}>Loadout</LinkChip>
        <LinkChip icon="chat" to="/app/chat" search={{ q: `@${unit.handle} ` }}>Chat</LinkChip>
      </div>
    </MapDrawer>
  );
}

export function RoadDrawer({ snap, road, onClose, onPickBuilding }: { snap: MapSnapshot; road: MapRoad; onClose: () => void; onPickBuilding: (ref: string) => void }) {
  const meta = ROAD_META[road.kind];
  const a = snap.resources.find((r) => r.ref === road.from);
  const b = snap.resources.find((r) => r.ref === road.to);
  const nameOf = (r: MapResource | undefined, ref: string) => (r ? resourceTitle(r) : ref);
  const agent = a?.agent;
  const verb = road.kind === 'promo' ? 'promos' : road.kind === 'repost' ? 'reposts' : 'duplicated posts';
  return (
    <MapDrawer
      title={`${nameOf(a, road.from)} → ${nameOf(b, road.to)}`}
      lead={<svg width="38" height="38" viewBox="0 0 38 38" aria-hidden style={{ flex: 'none' }}><line x1="4" y1="19" x2="34" y2="19" strokeWidth="3.5" strokeLinecap="round" strokeDasharray={meta.dash || undefined} style={{ stroke: meta.color }} /></svg>}
      subtitle={<Badge tone="neutral">{meta.label}</Badge>}
      onClose={onClose}
    >
      <Facts rows={[
        [`Last 30 days`, `${road.count30d} ${road.count30d === 1 ? verb.replace(/s$/, '') : verb}`],
        ['Last one', road.lastAt ? ago(road.lastAt) : '—'],
        ['Joined through links', road.joins30d != null ? `${road.joins30d} subscribers` : road.kind === 'promo' ? 'Not tracked' : null],
      ]} />
      <div className="map-links">
        <button type="button" className="map-link" onClick={() => onPickBuilding(road.from)}><Icon name="send" size={14} />From</button>
        <button type="button" className="map-link" onClick={() => onPickBuilding(road.to)}><Icon name="download" size={14} />To</button>
        {agent && <LinkChip icon="megaphone" to="/app/agents/$handle" params={{ handle: agent }} search={{ tab: 'promo' }}>Promo plan</LinkChip>}
      </div>
    </MapDrawer>
  );
}
