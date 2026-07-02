// GraphCanvas — canvas/WebGL-free 2D canvas renderer for the ad-relationship
// graph, built on `force-graph` (d3-force under the hood).
//
// WHY NOT reactflow: the previous implementation rendered every node as a DOM
// component and every edge as an SVG path. Past a few hundred elements the
// browser froze on layout+paint (the reported "graph page hangs the whole
// app"). force-graph draws the entire scene onto ONE <canvas>, so thousands
// of nodes/edges render at 60fps and the page stays responsive.
//
// Layout modes: 'force' (physics — default, best for big hairball networks),
// 'td' / 'lr' (dagre-style tree via force-graph's dagMode — preserves the
// "who advertises whom" reading direction). Ad graphs can contain cycles;
// when dag layout hits one, onDagError falls back to 'force' via the
// onLayoutFallback callback so the page can reset its toggle.
import { useEffect, useRef } from 'react';
import ForceGraph from 'force-graph';
import type { GraphResponse, GraphEdge } from '../api/types';

export type GraphLayout = 'force' | 'td' | 'lr';

const TIER_HEX: Record<'green' | 'orange' | 'red', string> = {
  green:  '#22c55e',
  orange: '#f59e0b',
  red:    '#ef4444',
};

interface FGNode {
  id:       string;
  label:    string;
  sub:      string | null;   // secondary line (e.g. @username)
  subs:     number | null;
  isMine:   boolean;
  external: boolean;
  kind:     string | null;   // external target kind (web / instagram / tg_user)
  // force-graph runtime fields
  x?: number; y?: number;
}

interface FGLink {
  source:   string;
  target:   string;
  count:    number;
  tier:     'green' | 'orange' | 'red';
  external: boolean;
  raw:      GraphEdge;
}

/** Stable id for the ghost node representing a non-tracked external target.
 *  Multiple posts pointing at the same external URL collapse onto one node. */
function externalId(kind: string, target: string): string {
  return `external:${kind}:${target.toLowerCase()}`;
}

/** GraphResponse → force-graph {nodes, links}, incl. ghost external nodes. */
function toGraphData(data: GraphResponse): { nodes: FGNode[]; links: FGLink[] } {
  const nodes: FGNode[] = data.nodes.map((n) => ({
    id:       n.id,
    label:    n.title ?? (n.username ? `@${n.username}` : n.id.slice(0, 8)),
    sub:      n.username ? `@${n.username}` : null,
    subs:     n.subs,
    isMine:   n.isMine,
    external: false,
    kind:     null,
  }));

  const externalsSeen = new Set<string>();
  for (const e of data.edges) {
    if (e.target) continue; // resolved targets are real channel nodes already
    const id = externalId(e.kind, e.target_username);
    if (externalsSeen.has(id)) continue;
    externalsSeen.add(id);
    nodes.push({
      id, label: e.target_username, sub: e.kind, subs: null,
      isMine: false, external: true, kind: e.kind,
    });
  }

  const links: FGLink[] = data.edges.map((e) => ({
    source:   e.source,
    target:   e.target ?? externalId(e.kind, e.target_username),
    count:    e.count,
    tier:     e.colorTier,
    external: !e.target,
    raw:      e,
  }));

  return { nodes, links };
}

/** Resolve theme colors once per mount — canvas needs concrete values. */
function themeColors() {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    ink:       v('--color-ink', '#ededed'),
    inkMuted:  v('--color-ink-muted', '#8f8f8f'),
    accent:    v('--color-accent', '#3ecf8e'),
    surface:   v('--color-surface-2', '#262626'),
    hairline:  v('--color-hairline-strong', '#3a3a3a'),
    canvas:    v('--color-canvas', '#171717'),
  };
}

interface Props {
  data: GraphResponse;
  layout: GraphLayout;
  onNodeClick: (channelId: string) => void;
  onEdgeClick: (edge: GraphEdge) => void;
  /** Called when a tree layout hits a cycle and the canvas falls back to force. */
  onLayoutFallback?: () => void;
}

export function GraphCanvas({ data, layout, onNodeClick, onEdgeClick, onLayoutFallback }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const graphRef     = useRef<ForceGraph<FGNode, FGLink> | null>(null);
  // Latest callbacks without re-creating the graph instance.
  const cbRef = useRef({ onNodeClick, onEdgeClick, onLayoutFallback });
  cbRef.current = { onNodeClick, onEdgeClick, onLayoutFallback };

  // One graph instance per mount; data/layout updates go through setters.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const theme = themeColors();
    const graph = new ForceGraph<FGNode, FGLink>(el);
    graphRef.current = graph;

    const nodeRadius = (n: FGNode) =>
      n.external ? 5 : 4 + Math.min(9, Math.log10((n.subs ?? 0) + 1) * 2.4);

    graph
      .backgroundColor('rgba(0,0,0,0)')
      .minZoom(0.05).maxZoom(8)
      .nodeId('id')
      .nodeLabel((n) => {
        if (n.external) return `${n.label} <span style="opacity:.65">(${n.kind})</span>`;
        const subs = n.subs != null ? ` · ${n.subs.toLocaleString()} subs` : '';
        return `<b>${n.label}</b>${n.sub && n.sub !== n.label ? ` ${n.sub}` : ''}${subs}`;
      })
      .nodeCanvasObject((n, ctx, scale) => {
        const r = nodeRadius(n);
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, r, 0, 2 * Math.PI);
        if (n.external) {
          ctx.setLineDash([3, 2]);
          ctx.strokeStyle = theme.inkMuted;
          ctx.lineWidth = 1;
          ctx.fillStyle = theme.canvas;
          ctx.fill(); ctx.stroke();
          ctx.setLineDash([]);
        } else {
          ctx.fillStyle = n.isMine ? theme.accent : theme.surface;
          ctx.strokeStyle = n.isMine ? theme.accent : theme.hairline;
          ctx.lineWidth = 1.2;
          ctx.fill(); ctx.stroke();
        }
        // Labels: constant screen size; skip while zoomed far out so huge
        // graphs stay readable (and cheap) — zoom in to reveal names.
        if (scale > 0.9) {
          const fontSize = Math.min(12 / scale, 12);
          ctx.font = `500 ${fontSize}px Inter, system-ui, sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = n.external ? theme.inkMuted : theme.ink;
          ctx.fillText(n.label, n.x!, n.y! + r + 2 / scale);
        }
      })
      .nodePointerAreaPaint((n, color, ctx) => {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, nodeRadius(n) + 4, 0, 2 * Math.PI);
        ctx.fillStyle = color;
        ctx.fill();
      })
      .linkColor((l) => TIER_HEX[l.tier])
      .linkWidth((l) => Math.min(1 + Math.log2(l.count + 1), 6) * 0.5)
      .linkLineDash((l) => (l.external ? [4, 3] : null))
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(1)
      .linkLabel((l) => {
        const e = l.raw;
        return `${e.count} ad post${e.count === 1 ? '' : 's'} → ${e.target_username} <span style="opacity:.65">(${e.kind})</span>`;
      })
      // Edge count labels only when zoomed in — drawing thousands of texts at
      // fit-view zoom is wasted paint AND unreadable chart-junk.
      .linkCanvasObjectMode(() => 'after')
      .linkCanvasObject((l, ctx, scale) => {
        if (scale < 1.4) return;
        const s = l.source as unknown as FGNode, t = l.target as unknown as FGNode;
        if (s.x == null || t.x == null) return;
        const fontSize = 10 / scale;
        ctx.font = `600 ${fontSize}px Inter, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = TIER_HEX[l.tier];
        ctx.fillText(String(l.count), (s.x + t.x!) / 2, (s.y! + t.y!) / 2 - 4 / scale);
      })
      .onNodeClick((n) => { if (!n.external) cbRef.current.onNodeClick(n.id); })
      .onLinkClick((l) => cbRef.current.onEdgeClick(l.raw))
      .onNodeHover((n) => { el.style.cursor = n ? (n.external ? 'default' : 'pointer') : ''; })
      .onLinkHover((l) => { el.style.cursor = l ? 'pointer' : ''; })
      .onDagError(() => {
        // Cycle in the data — tree layout impossible; fall back to physics.
        graph.dagMode(null);
        cbRef.current.onLayoutFallback?.();
      });

    // Track container size (canvas needs explicit pixel dimensions).
    const ro = new ResizeObserver(() => {
      graph.width(el.clientWidth).height(el.clientHeight);
    });
    ro.observe(el);
    graph.width(el.clientWidth).height(el.clientHeight);

    return () => {
      ro.disconnect();
      graph._destructor();
      graphRef.current = null;
    };
  }, []);

  // Data / layout updates. Rebuilding graphData resets the physics layout —
  // same behavior as the old dagre re-layout on data change.
  useEffect(() => {
    const graph = graphRef.current;
    if (!graph) return;

    const gd = toGraphData(data);
    const big = gd.nodes.length + gd.links.length > 600;

    graph
      .dagMode(layout === 'force' ? null : layout)
      .dagLevelDistance(140)
      // Big graphs: pre-run the simulation off-screen and render a settled,
      // STATIC scene (no seconds of wobbling while physics converge).
      .warmupTicks(big ? 120 : 40)
      .cooldownTicks(big ? 0 : 200)
      .graphData(gd);

    graph.d3ReheatSimulation();

    // Fit once the engine settles (fallback timer in case it already stopped).
    let fitted = false;
    const fit = () => { if (!fitted) { fitted = true; graph.zoomToFit(400, 48); } };
    graph.onEngineStop(fit);
    const t = window.setTimeout(fit, big ? 900 : 1600);
    return () => window.clearTimeout(t);
  }, [data, layout]);

  return (
    <div
      ref={containerRef}
      style={{
        height: '80vh', width: '100%',
        borderRadius: 'var(--radius-xl)',
        border: '1px solid var(--color-hairline)',
        background: 'var(--color-canvas)',
        overflow: 'hidden',
      }}
    />
  );
}
