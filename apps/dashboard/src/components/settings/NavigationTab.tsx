// Spec 027 FR-008: Settings → Navigation, the menu constructor.
//
// The draft is the normalized saved menu (nav/resolve.ts normalizeNav); every
// edit is a pure op from nav/ops.ts. Nothing is sent until Save; the PUT
// carries the revision the draft was based on, so a save from another tab in
// between is a 409 ("Changed in another tab — Reload") and the draft is kept.
// A leave-guard asks before navigating away from unsaved changes.
//
// Reorder: native HTML5 drag and drop (desktop), ↑/↓ buttons everywhere and
// Alt+↑/↓ on a focused row. Mobile hides the preview behind a toggle.
import { useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react';
import { useBlocker } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { navApi, NAV_CONFIG_KEY } from '../../api/nav';
import { Icon, ICON_NAMES, isIconName, type IconName } from '../ui/Icon';
import { SectionCard } from '../ui/primitives';
import { Badge } from '../ui/Badge';
import { Modal } from '../Modal';
import { useConfirm } from '../ui/ConfirmDialog';
import { describeError, toast } from '../ui/Toast';
import { useMediaQuery } from '../../lib/useMediaQuery';
import { NAV_GROUPS, NAV_REGISTRY, navEntry, FORCED_IDS } from '../../nav/registry';
import { normalizeNav, renderNav } from '../../nav/resolve';
import { NAV_LIMITS, newNavId, parseNavTarget, type NavConfigResponse, type NavConfigV1 } from '../../nav/config';
import { hrefOf, type ResolvedNav } from '../../nav/model';
import { writeNavCache } from '../../nav/cache';
import { isConflict, useNavConfig, useRouteExists } from '../../nav/store';
import {
  addCustomLink, addGroup, canHide, deleteGroup, hideItem, moveGroup, moveItemBefore, nudgeGroup, nudgeItem,
  refCount, removeRef, renameGroup, setGroupHidden, setOverride, showItem, togglePin,
} from '../../nav/ops';

const BUILTIN_TITLE = new Map(NAV_GROUPS.map((g) => [g.id as string, g.title]));

interface Base { revision: string | null; json: string; source: ReturnType<typeof normalizeNav>['source']; unparseable: boolean }

export function NavigationTab({ editId, from }: { editId?: string; from?: string }) {
  const q = useNavConfig();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const routeExists = useRouteExists();
  const isMobile = useMediaQuery('(max-width: 860px)');

  const [draft, setDraft] = useState<NavConfigV1 | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [conflict, setConflict] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [iconFor, setIconFor] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);

  const dirty = !!draft && !!base && JSON.stringify(draft) !== base.json;
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  const load = (data: NavConfigResponse) => {
    const n = normalizeNav(NAV_REGISTRY, data.config);
    setDraft(n.config);
    setBase({ revision: data.revision, json: JSON.stringify(n.config), source: n.source, unparseable: data.warning === 'unparseable' });
    setConflict(false);
  };

  // Start from the server's copy (not the first-paint cache), and follow it while
  // there are no local edits (e.g. a pin from the sidebar).
  useEffect(() => {
    if (!q.data || !q.isFetchedAfterMount) return;
    if (!dirtyRef.current) load(q.data);
  }, [q.data, q.isFetchedAfterMount]); // eslint-disable-line react-hooks/exhaustive-deps

  // ?edit=<id> (sidebar "Rename…"): focus that item's label once the draft is there.
  useEffect(() => {
    if (!draft || !editId) return;
    const el = document.getElementById(`navc-label-${editId}`) as HTMLInputElement | null;
    if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); el.focus({ preventScroll: true }); el.select(); }
  }, [!!draft, editId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard reorder keeps focus on the moved row.
  useEffect(() => {
    if (!focusId) return;
    document.querySelector<HTMLElement>(`[data-navc-row="${CSS.escape(focusId)}"]`)?.focus();
    setFocusId(null);
  }, [focusId, draft]);

  useBlocker({
    shouldBlockFn: async () => {
      if (!dirtyRef.current) return false;
      const leave = await confirm('leave without saving your menu changes', { danger: true, confirmLabel: 'Leave' });
      return !leave;
    },
    enableBeforeUnload: () => dirtyRef.current,
  });

  const save = useMutation({
    mutationFn: (v: { config: NavConfigV1; base: string | null }) => navApi.putConfig(v.config, v.base),
    meta: { silentError: true },
    onSuccess: (r, v) => {
      const fresh: NavConfigResponse = { config: v.config as unknown as Record<string, unknown>, revision: r.revision };
      qc.setQueryData(NAV_CONFIG_KEY, fresh);
      writeNavCache(fresh);
      setBase({ revision: r.revision, json: JSON.stringify(v.config), source: 'saved', unparseable: false });
      setConflict(false);
      toast.success('Menu saved');
    },
    onError: (e) => {
      if (isConflict(e)) setConflict(true);
      else toast.error(`Couldn't save the menu: ${describeError(e)}`);
    },
  });

  const reset = useMutation({
    mutationFn: () => navApi.resetConfig(),
    meta: { silentError: true },
    onSuccess: () => {
      const fresh: NavConfigResponse = { config: null, revision: null };
      qc.setQueryData(NAV_CONFIG_KEY, fresh);
      writeNavCache(fresh);
      load(fresh);
      toast.success('Menu reset to the default');
    },
    onError: (e) => toast.error(`Couldn't reset the menu: ${describeError(e)}`),
  });

  const reload = async () => {
    const r = await q.refetch();
    if (r.data) load(r.data);
  };

  const preview: ResolvedNav | null = useMemo(
    () => (draft ? renderNav(NAV_REGISTRY, normalizeNav(NAV_REGISTRY, draft), { routeExists, isIcon: isIconName }) : null),
    [draft, routeExists],
  );

  if (q.error && !draft) return <div className="callout-danger">Couldn't load the menu: {describeError(q.error)}</div>;
  if (!draft || !base) return <p className="text-body-sm" style={{ color: 'var(--color-ink-muted)' }}>Loading…</p>;

  const blocked = base.source === 'newer';
  const edit = (op: (c: NavConfigV1) => NavConfigV1) => setDraft((d) => (d ? op(d) : d));
  const refs = refCount(draft);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16, paddingBottom: 72 }}>
      {blocked && (
        <div className="callout-warning" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>This menu was saved by a newer version of the dashboard. Reload the page to edit it; saving here is blocked so it is not overwritten.</span>
          <button className="btn-tiny" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      )}
      {base.unparseable && (
        <div className="callout-warning">The saved menu could not be read, so the default is shown. Save to replace it, or reset to the default.</div>
      )}
      {conflict && (
        <div className="callout-danger" role="alert" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span>Changed in another tab. Your draft is kept here; reload to see the latest menu (your changes will be discarded).</span>
          <button className="btn-tiny" onClick={() => void reload()}>Reload</button>
        </div>
      )}

      <div className="navc-layout">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
          <SectionCard icon="menu" title="Menu"
            action={<span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{refs}/{NAV_LIMITS.refs} items · {draft.groups.length}/{NAV_LIMITS.groups} groups</span>}>
            <p className="text-caption" style={{ margin: '-6px 0 14px', color: 'var(--color-ink-muted)' }}>
              {isMobile ? 'Use ↑ and ↓ to reorder.' : 'Drag rows and groups, or use ↑/↓ (Alt+↑/↓ on a focused row).'} Hidden pages keep working; find them with ⌘K.
              Overview and Settings are always shown.
            </p>
            <Tree draft={draft} edit={edit} isMobile={isMobile} onPickIcon={setIconFor} onFocusRow={setFocusId} />
            <NewGroup draft={draft} edit={edit} />
          </SectionCard>

          <AddLink draft={draft} edit={edit} from={from} routeExists={routeExists} />
          <HiddenPanel draft={draft} edit={edit} preview={preview} />
        </div>

        {(!isMobile || showPreview) && preview && (
          <div className="navc-preview-wrap">
            <SectionCard icon="eye" title="Preview">
              <MenuPreview nav={preview} />
            </SectionCard>
          </div>
        )}
      </div>

      <div className="navc-bar" role="region" aria-label="Save menu changes">
        <span className="text-caption" style={{ color: dirty ? 'var(--color-warning)' : 'var(--color-ink-dim)', marginRight: 'auto' }}>
          {dirty ? 'Unsaved changes' : base.revision ? 'Saved' : 'Default menu'}
        </span>
        {isMobile && (
          <button className="btn-tiny" onClick={() => setShowPreview((v) => !v)} aria-pressed={showPreview}>
            <Icon name="eye" size={13} /> {showPreview ? 'Hide preview' : 'Preview'}
          </button>
        )}
        <button className="btn-tiny" disabled={reset.isPending || blocked || (!base.revision && !base.unparseable)}
          title="Delete the saved menu and use the default"
          onClick={async () => {
            if (await confirm('reset the menu to the default', { danger: true, confirmLabel: 'Reset', details: 'Your groups, renames, pins, hidden pages and custom links are deleted. Every page keeps working.' })) reset.mutate();
          }}>
          <Icon name="reset" size={13} /> Reset to default
        </button>
        <button className="btn-secondary" disabled={!dirty || save.isPending} onClick={() => setDraft(JSON.parse(base.json))}>Discard</button>
        <button className="btn-primary" disabled={!dirty || save.isPending || blocked}
          onClick={() => save.mutate({ config: draft, base: base.revision })}>
          {save.isPending ? 'Saving…' : 'Save'}
        </button>
      </div>

      <IconPicker
        open={!!iconFor}
        current={iconFor ? currentIcon(draft, iconFor) : null}
        onClose={() => setIconFor(null)}
        onPick={(name) => { if (iconFor) edit((c) => setOverride(c, iconFor, { icon: name })); setIconFor(null); }}
        onReset={iconFor && !draft.custom.some((x) => x.id === iconFor) ? () => { edit((c) => setOverride(c, iconFor, { icon: '' })); setIconFor(null); } : undefined}
      />
    </div>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function defaultLabel(draft: NavConfigV1, id: string): string {
  return navEntry(id)?.label ?? draft.custom.find((c) => c.id === id)?.label ?? id;
}

function currentIcon(draft: NavConfigV1, id: string): IconName {
  const custom = draft.custom.find((c) => c.id === id);
  const name = custom?.icon ?? draft.overrides[id]?.icon ?? navEntry(id)?.icon ?? 'globe';
  return isIconName(name) ? name : 'globe';
}

/** A text input that commits on blur/Enter (so trimming never fights typing); Escape reverts. */
function CommitInput({ id, value, placeholder, label, onCommit, disabled, maxLength = NAV_LIMITS.label }: {
  id?: string; value: string; placeholder?: string; label: string; onCommit: (v: string) => void; disabled?: boolean; maxLength?: number;
}) {
  const [v, setV] = useState(value);
  useEffect(() => { setV(value); }, [value]);
  return (
    <input id={id} className="input-field navc-input" value={v} placeholder={placeholder} aria-label={label} maxLength={maxLength} disabled={disabled}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { if (v !== value) onCommit(v); }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
        if (e.key === 'Escape') { setV(value); }
        e.stopPropagation();
      }} />
  );
}

type Drag = { kind: 'item' | 'group'; id: string } | null;

function Tree({ draft, edit, isMobile, onPickIcon, onFocusRow }: {
  draft: NavConfigV1; edit: (op: (c: NavConfigV1) => NavConfigV1) => void; isMobile: boolean;
  onPickIcon: (id: string) => void; onFocusRow: (id: string) => void;
}) {
  const [drag, setDrag] = useState<Drag>(null);
  const [over, setOver] = useState<{ group: string; before: string | null } | { groupBefore: string | null } | null>(null);
  const dnd = !isMobile;

  // The grip is the drag handle (inputs inside a draggable row break text selection);
  // the whole row is the drag image.
  const startDrag = (e: DragEvent, d: NonNullable<Drag>) => {
    e.stopPropagation();
    const row = (e.currentTarget as HTMLElement).closest('.navc-item, .navc-group-head');
    if (row) e.dataTransfer.setDragImage(row, 16, 16);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${d.kind}:${d.id}`);
    setDrag(d);
  };
  const endDrag = () => { setDrag(null); setOver(null); };

  const itemOver = (e: DragEvent, group: string, id: string) => {
    if (drag?.kind !== 'item') return;
    e.preventDefault();
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const after = e.clientY > r.top + r.height / 2;
    const g = draft.groups.find((x) => x.id === group)!;
    const i = g.items.indexOf(id);
    setOver({ group, before: after ? g.items[i + 1] ?? null : id });
  };
  const groupOver = (e: DragEvent, group: string) => {
    e.preventDefault();
    if (drag?.kind === 'item') { if (!over || !('group' in over) || over.group !== group) setOver({ group, before: null }); return; }
    if (drag?.kind === 'group') {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const i = draft.groups.findIndex((x) => x.id === group);
      setOver({ groupBefore: e.clientY > r.top + r.height / 2 ? draft.groups[i + 1]?.id ?? null : group });
    }
  };
  const drop = (e: DragEvent) => {
    e.preventDefault();
    if (drag && over) {
      if (drag.kind === 'item' && 'group' in over) edit((c) => moveItemBefore(c, drag.id, over.group, over.before));
      if (drag.kind === 'group' && 'groupBefore' in over) {
        edit((c) => {
          const rest = c.groups.filter((g) => g.id !== drag.id);
          const at = over.groupBefore === null ? rest.length : rest.findIndex((g) => g.id === over.groupBefore);
          return moveGroup(c, drag.id, at < 0 ? rest.length : at);
        });
      }
    }
    endDrag();
  };

  const rowKeys = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    edit((c) => nudgeItem(c, id, e.key === 'ArrowUp' ? -1 : 1));
    onFocusRow(id);
  };
  const groupKeys = (e: KeyboardEvent, id: string) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    edit((c) => nudgeGroup(c, id, e.key === 'ArrowUp' ? -1 : 1));
    onFocusRow(`group:${id}`);
  };

  return (
    <div className="navc-tree" onDragEnd={endDrag} onDrop={drop}>
      {draft.groups.map((g, gi) => {
        const builtin = BUILTIN_TITLE.get(g.id);
        const showGroupLine = over && 'groupBefore' in over && over.groupBefore === g.id;
        return (
          <div key={g.id}
            className={`navc-group${g.hidden ? ' is-hidden' : ''}${drag?.kind === 'group' && drag.id === g.id ? ' is-dragging' : ''}${showGroupLine ? ' drop-before' : ''}`}
            onDragOver={(e) => groupOver(e, g.id)}>
            <div className="navc-group-head" tabIndex={0} data-navc-row={`group:${g.id}`} onKeyDown={(e) => groupKeys(e, g.id)}
              aria-label={`Group ${g.title ?? builtin ?? ''}`}>
              {dnd && (
                <span className="navc-grip" draggable onDragStart={(e) => startDrag(e, { kind: 'group', id: g.id })} title="Drag to reorder groups" aria-hidden>
                  <Icon name="grip" size={14} />
                </span>
              )}
              <CommitInput value={g.title ?? ''} placeholder={builtin ?? 'Group name'} label="Group name"
                onCommit={(v) => edit((c) => renameGroup(c, g.id, v))} />
              {g.hidden && <Badge>hidden</Badge>}
              <span className="navc-actions">
                <button className="btn-act" title={g.hidden ? 'Show group' : 'Hide group'} aria-label={g.hidden ? 'Show group' : 'Hide group'}
                  onClick={() => edit((c) => setGroupHidden(c, g.id, !g.hidden))}>
                  <Icon name={g.hidden ? 'eye' : 'eye-off'} size={14} />
                </button>
                <button className="btn-act" title="Move group up" aria-label="Move group up" disabled={gi === 0}
                  onClick={() => edit((c) => nudgeGroup(c, g.id, -1))}><Icon name="chevron-up" size={14} /></button>
                <button className="btn-act" title="Move group down" aria-label="Move group down" disabled={gi === draft.groups.length - 1}
                  onClick={() => edit((c) => nudgeGroup(c, g.id, 1))}><Icon name="chevron-down" size={14} /></button>
                {!builtin && (
                  <button className="btn-act btn-act-danger" title="Delete group (its pages go to Hidden)" aria-label="Delete group"
                    onClick={() => edit((c) => deleteGroup(c, g.id))}><Icon name="trash" size={14} /></button>
                )}
              </span>
            </div>

            <div className="navc-items">
              {g.items.map((id, ii) => {
                const entry = navEntry(id);
                const custom = draft.custom.find((c) => c.id === id);
                const pinned = draft.pinned.includes(id);
                const forced = FORCED_IDS.includes(id);
                const showLine = over && 'group' in over && over.group === g.id && over.before === id && drag?.id !== id;
                const first = gi === 0 && ii === 0;
                const last = gi === draft.groups.length - 1 && ii === g.items.length - 1;
                return (
                  <div key={id} data-navc-row={id} tabIndex={0}
                    className={`navc-item${drag?.kind === 'item' && drag.id === id ? ' is-dragging' : ''}${showLine ? ' drop-before' : ''}`}
                    onDragOver={(e) => itemOver(e, g.id, id)}
                    onKeyDown={(e) => rowKeys(e, id)} aria-label={defaultLabel(draft, id)}>
                    {dnd && (
                      <span className="navc-grip" draggable onDragStart={(e) => startDrag(e, { kind: 'item', id })} title="Drag to move" aria-hidden>
                        <Icon name="grip" size={14} />
                      </span>
                    )}
                    <button className="btn-act" title="Change icon" aria-label="Change icon" onClick={() => onPickIcon(id)}>
                      <Icon name={currentIcon(draft, id)} size={14} />
                    </button>
                    <CommitInput id={`navc-label-${id}`}
                      value={custom ? custom.label : draft.overrides[id]?.label ?? ''}
                      placeholder={entry?.label ?? 'Label'} label={`Label for ${defaultLabel(draft, id)}`}
                      onCommit={(v) => edit((c) => setOverride(c, id, { label: v }))} />
                    {custom && <span className="navc-meta" title={hrefOf(custom)}>{hrefOf(custom)}</span>}
                    <span className="navc-actions">
                      <button className={`btn-act${pinned ? ' is-on' : ''}`} aria-pressed={pinned}
                        title={pinned ? 'Unpin' : 'Pin to the top'} aria-label={pinned ? 'Unpin' : 'Pin'}
                        disabled={!pinned && draft.pinned.length >= NAV_LIMITS.pinned}
                        onClick={() => edit((c) => togglePin(c, id))}><Icon name="star" size={14} /></button>
                      {entry?.badge && (
                        <button className={`btn-act${draft.overrides[id]?.badge === false ? '' : ' is-on'}`}
                          aria-pressed={draft.overrides[id]?.badge !== false}
                          title={draft.overrides[id]?.badge === false ? 'Show the counter' : 'Hide the counter'}
                          aria-label="Counter on/off"
                          onClick={() => edit((c) => setOverride(c, id, { badge: draft.overrides[id]?.badge === false }))}>
                          <Icon name="info" size={14} />
                        </button>
                      )}
                      <button className="btn-act" title={forced ? 'Always shown' : 'Hide from the menu'} aria-label="Hide"
                        disabled={!canHide(id)} onClick={() => edit((c) => hideItem(c, id))}><Icon name="eye-off" size={14} /></button>
                      <button className="btn-act" title="Move up" aria-label="Move up" disabled={first}
                        onClick={() => { edit((c) => nudgeItem(c, id, -1)); }}><Icon name="chevron-up" size={14} /></button>
                      <button className="btn-act" title="Move down" aria-label="Move down" disabled={last}
                        onClick={() => { edit((c) => nudgeItem(c, id, 1)); }}><Icon name="chevron-down" size={14} /></button>
                    </span>
                  </div>
                );
              })}
              {g.items.length === 0 && <div className="navc-empty">Empty group: drop pages here (it is not shown in the menu while empty).</div>}
              {over && 'group' in over && over.group === g.id && over.before === null && drag?.kind === 'item' && <div className="navc-drop-end" />}
            </div>
          </div>
        );
      })}
      {over && 'groupBefore' in over && over.groupBefore === null && <div className="navc-drop-end" />}
    </div>
  );
}

function NewGroup({ draft, edit }: { draft: NavConfigV1; edit: (op: (c: NavConfigV1) => NavConfigV1) => void }) {
  const [title, setTitle] = useState('');
  const full = draft.groups.length >= NAV_LIMITS.groups;
  const add = () => {
    if (!title.trim() || full) return;
    edit((c) => addGroup(c, newNavId('g_c_'), title));
    setTitle('');
  };
  return (
    <form className="navc-inline-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
      <input className="input-field" value={title} maxLength={NAV_LIMITS.label} placeholder="New group name" aria-label="New group name"
        onChange={(e) => setTitle(e.target.value)} />
      <button type="submit" className="btn-secondary" disabled={!title.trim() || full} title={full ? `At most ${NAV_LIMITS.groups} groups` : undefined}>
        <Icon name="folder-plus" size={14} /> Add group
      </button>
    </form>
  );
}

function AddLink({ draft, edit, from, routeExists }: {
  draft: NavConfigV1; edit: (op: (c: NavConfigV1) => NavConfigV1) => void; from?: string; routeExists: (href: string) => boolean;
}) {
  const [label, setLabel] = useState('');
  const [target, setTarget] = useState('');
  const [icon, setIcon] = useState<IconName>('link');
  const [group, setGroup] = useState(draft.groups[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const full = draft.custom.length >= NAV_LIMITS.custom;
  const capturable = !!from && !from.startsWith('/app/settings');

  const capture = () => {
    if (!from) return;
    setTarget(from);
    const t = parseNavTarget(from);
    const known = t && NAV_REGISTRY.find((e) => e.menu !== false && hrefOf(e) === hrefOf(t));
    if (!label) setLabel(known ? known.label : guessLabel(t?.to ?? from));
    setError(null);
  };
  const add = () => {
    const t = parseNavTarget(target);
    if (!t) { setError('Use an internal page address that starts with /app, e.g. /app/channels?filter=external'); return; }
    if (!routeExists(t.to)) { setError('No page matches this address.'); return; }
    if (!label.trim()) { setError('Give the link a label.'); return; }
    edit((c) => addCustomLink(c, { id: newNavId('c_'), label, icon, ...t }, group));
    setLabel(''); setTarget(''); setError(null);
    toast.success('Link added to the draft. Save to keep it.');
  };

  return (
    <SectionCard icon="link" title="Add a link"
      action={capturable ? (
        <button className="btn-tiny" onClick={capture} title={from}><Icon name="plus" size={12} /> Add current page</button>
      ) : undefined}>
      <p className="text-caption" style={{ margin: '-6px 0 12px', color: 'var(--color-ink-muted)' }}>
        Any dashboard page, with its filters: type the address or use <b>Add current page</b> (open this tab with “Edit menu” from that page).
      </p>
      <form className="navc-link-form" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <button type="button" className="btn-act" title="Choose icon" aria-label="Choose icon" onClick={() => setPicking(true)}>
          <Icon name={icon} size={14} />
        </button>
        <input className="input-field" value={label} maxLength={NAV_LIMITS.label} placeholder="Label" aria-label="Link label" onChange={(e) => setLabel(e.target.value)} />
        <input className="input-field" value={target} placeholder="/app/channels?filter=external&q=crypto" aria-label="Link address"
          onChange={(e) => { setTarget(e.target.value); setError(null); }} style={{ flex: 2 }} />
        <select className="input-field" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Group">
          {draft.groups.map((g) => <option key={g.id} value={g.id}>{g.title ?? BUILTIN_TITLE.get(g.id) ?? g.id}</option>)}
        </select>
        <button type="submit" className="btn-primary" disabled={full} title={full ? `At most ${NAV_LIMITS.custom} links` : undefined}>Add link</button>
      </form>
      {error && <p className="text-micro" role="alert" style={{ color: 'var(--color-danger)', margin: '8px 0 0' }}>{error}</p>}
      <IconPicker open={picking} current={icon} onClose={() => setPicking(false)} onPick={(n) => { setIcon(n); setPicking(false); }} />
    </SectionCard>
  );
}

function guessLabel(path: string): string {
  const seg = path.split('/').filter(Boolean).pop() ?? 'Page';
  const s = decodeURIComponentSafe(seg).replace(/[-_]+/g, ' ').replace(/^@/, '@');
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, NAV_LIMITS.label);
}
function decodeURIComponentSafe(s: string): string { try { return decodeURIComponent(s); } catch { return s; } }

function HiddenPanel({ draft, edit, preview }: { draft: NavConfigV1; edit: (op: (c: NavConfigV1) => NavConfigV1) => void; preview: ResolvedNav | null }) {
  const unavailable = preview?.unavailable ?? [];
  const unavailableIds = new Set(unavailable.map((u) => u.id));
  const hidden = draft.hidden.filter((id) => !unavailableIds.has(id) && (navEntry(id) || draft.custom.some((c) => c.id === id)));
  const restore = (id: string) => {
    const target = navEntry(id)?.defaultGroup;
    edit((c) => showItem(c, id, c.groups.some((g) => g.id === target && !g.hidden) ? target : undefined));
  };
  return (
    <SectionCard icon="eye-off" title={`Hidden${unavailable.length ? ' and unavailable' : ''}`}
      action={<span className="text-micro" style={{ color: 'var(--color-ink-dim)' }}>{hidden.length} hidden</span>}>
      {hidden.length === 0 && unavailable.length === 0 && (
        <p className="text-caption" style={{ margin: 0, color: 'var(--color-ink-muted)' }}>Nothing is hidden.</p>
      )}
      {hidden.map((id) => {
        const custom = draft.custom.find((c) => c.id === id);
        return (
          <div key={id} className="navc-hidden-row">
            <Icon name={currentIcon(draft, id)} size={14} />
            <span className="navc-hidden-label">{draft.overrides[id]?.label ?? defaultLabel(draft, id)}</span>
            <span className="navc-meta">{hrefOf(custom ?? navEntry(id)!)}</span>
            <span className="navc-actions">
              <button className="btn-tiny" onClick={() => restore(id)}>Restore</button>
              {custom && <button className="btn-tiny btn-tiny-danger" onClick={() => edit((c) => removeRef(c, id))}>Remove</button>}
            </span>
          </div>
        );
      })}
      {unavailable.length > 0 && (
        <>
          <div className="text-eyebrow" style={{ margin: '14px 0 6px' }}>Unavailable</div>
          {unavailable.map((u) => (
            <div key={u.id} className="navc-hidden-row">
              <Icon name="ban" size={14} />
              <span className="navc-hidden-label">{u.label}</span>
              <span className="navc-meta">{u.reason === 'removed' ? 'This page was removed in an update' : 'This page no longer exists'}</span>
              <span className="navc-actions">
                <button className="btn-tiny btn-tiny-danger" onClick={() => edit((c) => removeRef(c, u.id))}>Remove</button>
              </span>
            </div>
          ))}
        </>
      )}
    </SectionCard>
  );
}

/** The live preview: the draft as the sidebar will render it (not clickable). */
function MenuPreview({ nav }: { nav: ResolvedNav }) {
  const row = (i: ResolvedNav['groups'][number]['items'][number], k: string) => (
    <div key={k} className={`navc-preview-item${i.unavailable ? ' is-unavailable' : ''}`} title={i.unavailable ? 'This page no longer exists' : undefined}>
      <Icon name={i.icon} size={14} /> <span>{i.label}</span>
      {i.badge && <span className="navc-preview-badge" title="Shows a counter">#</span>}
    </div>
  );
  return (
    <div className="navc-preview" aria-label="Menu preview">
      {nav.pinned.length > 0 && (
        <div>
          <div className="navc-preview-title">Pinned</div>
          {nav.pinned.map((i) => row(i, `p:${i.id}`))}
        </div>
      )}
      {nav.groups.map((g) => (
        <div key={g.id}>
          <div className="navc-preview-title">{g.title}</div>
          {g.items.map((i) => row(i, `${g.id}:${i.id}`))}
        </div>
      ))}
    </div>
  );
}

function IconPicker({ open, current, onClose, onPick, onReset }: {
  open: boolean; current: IconName | null; onClose: () => void; onPick: (n: IconName) => void; onReset?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const names = ICON_NAMES.filter((n) => n.includes(filter.trim().toLowerCase()));
  return (
    <Modal open={open} onClose={onClose} title="Choose an icon" icon="sparkles" size="lg">
      <input className="input-field" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter icons" aria-label="Filter icons"
        style={{ width: '100%', marginBottom: 12 }} autoFocus />
      <div className="navc-icon-grid">
        {names.map((n) => (
          <button key={n} type="button" className={`navc-icon-btn${n === current ? ' is-on' : ''}`} title={n} aria-label={n} aria-pressed={n === current}
            onClick={() => onPick(n)}>
            <Icon name={n} size={16} />
          </button>
        ))}
      </div>
      {onReset && (
        <div className="modal-foot"><button className="btn-secondary" onClick={onReset}>Use the default icon</button></div>
      )}
    </Modal>
  );
}
