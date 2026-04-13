/**
 * ProofGraph v3 — Proof evolution visualization
 *
 * Fixed: zoom/pan works properly (touch-action:none, bounded scale 0.15-3, all wheel=pan, ctrl+wheel=zoom)
 * Fixed: compact grid layout with rounded convex-hull file bags, collision-free placement
 * Fixed: timeline click updates code + milestones in sidebar (iteration-aware API)
 * Fixed: 3 colors only: green/orange/red
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  useProofGraphDeclarations, useProofGraphTimeline, useProofGraphSnapshot, useProofGraphNodeDetail,
  type GraphDeclaration, type DeclarationsResponse, type TimelinePoint,
} from '../hooks/useProofGraph';
import { STATUS_COLORS } from '../utils/constants';
import AttemptCard from '../components/AttemptCard';
import LeanCodeLine from '../components/LeanCodeLine';
import { highlightLeanLines } from '../utils/leanHighlight';
import styles from './ProofGraph.module.css';

const COLOR_GREEN = '#28a745', COLOR_ORANGE = '#e36209', COLOR_RED = '#cb2431';

function nodeColor(hasSorry: boolean, touched: boolean): string {
  if (!hasSorry) return COLOR_GREEN;
  return touched ? COLOR_ORANGE : COLOR_RED;
}

// ── Compact layout: grid of file groups, nodes packed inside ─────────

interface LNode {
  id: string; decl: GraphDeclaration; x: number; y: number; w: number; h: number;
  color: string; touched: boolean;
}
interface LGroup {
  file: string; nodes: LNode[];
  // Bounding hull (padded rounded rect)
  hx: number; hy: number; hw: number; hh: number; colorIdx: number;
}
interface LEdge { from: LNode; to: LNode; blocked: boolean; }
interface Layout { nodes: LNode[]; groups: LGroup[]; edges: LEdge[]; w: number; h: number; }

const NW = 170, NH = 42, NGAP = 8, GPAD = 14, GHEADER = 20, GGAP = 24;
const FILLS = ['rgba(3,102,214,0.06)','rgba(111,66,193,0.06)','rgba(227,98,9,0.06)','rgba(40,167,69,0.06)','rgba(203,36,49,0.06)','rgba(0,134,114,0.06)'];
const STROKES = ['rgba(3,102,214,0.22)','rgba(111,66,193,0.22)','rgba(227,98,9,0.22)','rgba(40,167,69,0.22)','rgba(203,36,49,0.22)','rgba(0,134,114,0.22)'];

function computeLayout(decls: GraphDeclaration[], edges: { from: string; to: string }[],
  files: { file: string; declarations: string[] }[], touchedSet: Set<string>): Layout {
  const nodeMap = new Map<string, LNode>();
  const groups: LGroup[] = [];

  // Determine grid columns: try to keep it roughly square
  const activeFiles = files.filter(f => decls.some(d => d.file === f.file));
  const nFiles = activeFiles.length;
  if (nFiles === 0) return { nodes: [], groups: [], edges: [], w: 400, h: 400 };

  const cols = Math.max(1, Math.round(Math.sqrt(nFiles * 1.4)));

  let gx = GGAP, gy = GGAP, col = 0;
  let rowMaxH = 0;

  for (let fi = 0; fi < activeFiles.length; fi++) {
    const fg = activeFiles[fi];
    const fileDecls = decls.filter(d => d.file === fg.file);
    if (fileDecls.length === 0) continue;

    // Pack nodes: 2 columns inside if >6 decls, else 1
    const innerCols = fileDecls.length > 6 ? 2 : 1;
    const perCol = Math.ceil(fileDecls.length / innerCols);
    const gw = innerCols * NW + (innerCols - 1) * NGAP + GPAD * 2;
    const gh = GHEADER + perCol * (NH + NGAP) - NGAP + GPAD;

    const groupNodes: LNode[] = [];
    for (let di = 0; di < fileDecls.length; di++) {
      const d = fileDecls[di];
      const c = Math.floor(di / perCol);
      const r = di % perCol;
      const nx = gx + GPAD + c * (NW + NGAP);
      const ny = gy + GHEADER + r * (NH + NGAP);
      const touched = touchedSet.has(d.id) || touchedSet.has(d.file);
      const n: LNode = { id: d.id, decl: d, x: nx, y: ny, w: NW, h: NH, color: nodeColor(d.hasSorry, touched), touched };
      nodeMap.set(d.id, n);
      groupNodes.push(n);
    }

    groups.push({ file: fg.file, nodes: groupNodes, hx: gx, hy: gy, hw: gw, hh: gh, colorIdx: fi % FILLS.length });
    rowMaxH = Math.max(rowMaxH, gh);

    col++;
    if (col >= cols) {
      col = 0; gx = GGAP; gy += rowMaxH + GGAP; rowMaxH = 0;
    } else {
      gx += gw + GGAP;
    }
  }

  const allNodes = Array.from(nodeMap.values());
  const maxX = Math.max(...groups.map(g => g.hx + g.hw), 400) + GGAP;
  const maxY = Math.max(...groups.map(g => g.hy + g.hh), 400) + GGAP;

  const layoutEdges: LEdge[] = [];
  for (const e of edges) {
    const from = nodeMap.get(e.from), to = nodeMap.get(e.to);
    if (from && to) layoutEdges.push({ from, to, blocked: to.decl.hasSorry });
  }

  return { nodes: allNodes, groups, edges: layoutEdges, w: maxX, h: maxY };
}

// ── Zoom/Pan with proper boundary and touch-action ───────────────────

function useZoomPan(contentW: number, contentH: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [scale, setScale] = useState(1);
  const dragging = useRef(false);
  const lastPos = useRef({ x: 0, y: 0 });

  // Fit-to-view on first render or content change
  useEffect(() => {
    const el = ref.current;
    if (!el || contentW <= 0 || contentH <= 0) return;
    const rect = el.getBoundingClientRect();
    const sx = rect.width / contentW;
    const sy = rect.height / contentH;
    const s = Math.min(sx, sy, 1) * 0.92; // slight margin
    setScale(s);
    setTx((rect.width - contentW * s) / 2);
    setTy((rect.height - contentH * s) / 2);
  }, [contentW, contentH]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const clampScale = (s: number) => Math.max(0.15, Math.min(3, s));

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) < 4 && e.deltaX === 0) {
        // Pinch-to-zoom or ctrl+scroll
        const factor = 1 - e.deltaY * 0.003;
        setScale(prev => {
          const ns = clampScale(prev * factor);
          const ratio = ns / prev;
          setTx(t => mx - (mx - t) * ratio);
          setTy(t => my - (my - t) * ratio);
          return ns;
        });
      } else {
        // Two-finger pan
        setTx(t => t - e.deltaX);
        setTy(t => t - e.deltaY);
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button !== 0) return;
      // Only start drag if clicking on the background (not on a node)
      const target = e.target as HTMLElement;
      if (target.closest('[data-node]')) return;
      dragging.current = true;
      lastPos.current = { x: e.clientX, y: e.clientY };
      el.style.cursor = 'grabbing';
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!dragging.current) return;
      setTx(t => t + e.clientX - lastPos.current.x);
      setTy(t => t + e.clientY - lastPos.current.y);
      lastPos.current = { x: e.clientX, y: e.clientY };
    };
    const onMouseUp = () => { dragging.current = false; el.style.cursor = 'grab'; };

    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const zoomIn = useCallback(() => {
    const el = ref.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    setScale(prev => { const ns = Math.min(3, prev * 1.3); const r = ns / prev; setTx(t => mx - (mx - t) * r); setTy(t => my - (my - t) * r); return ns; });
  }, []);
  const zoomOut = useCallback(() => {
    const el = ref.current; if (!el) return;
    const rect = el.getBoundingClientRect();
    const mx = rect.width / 2, my = rect.height / 2;
    setScale(prev => { const ns = Math.max(0.15, prev / 1.3); const r = ns / prev; setTx(t => mx - (mx - t) * r); setTy(t => my - (my - t) * r); return ns; });
  }, []);
  const resetView = useCallback(() => {
    const el = ref.current;
    if (!el || contentW <= 0 || contentH <= 0) return;
    const rect = el.getBoundingClientRect();
    const sx = rect.width / contentW, sy = rect.height / contentH;
    const s = Math.min(sx, sy, 1) * 0.92;
    setScale(s); setTx((rect.width - contentW * s) / 2); setTy((rect.height - contentH * s) / 2);
  }, [contentW, contentH]);

  return { ref, tx, ty, scale, zoomIn, zoomOut, resetView };
}

// ── Sparkline ────────────────────────────────────────────────────────

function Sparkline({ data, activeIdx, w = 280, h = 36 }: { data: number[]; activeIdx?: number; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const mx = Math.max(...data, 1);
  const sx = w / (data.length - 1);
  const pts = data.map((v, i) => `${i * sx},${h - (v / mx) * (h - 4)}`).join(' ');
  return (
    <svg className={styles.sparklineSvg} width={w} height={h} viewBox={`0 0 ${w} ${h}`}>
      <polygon points={`0,${h} ${pts} ${(data.length - 1) * sx},${h}`} fill="rgba(3,102,214,0.08)" />
      <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth="1.5" />
      {data.map((v, i) => <circle key={i} cx={i * sx} cy={h - (v / mx) * (h - 4)} r={i === activeIdx ? 4 : 2} fill={v === 0 ? COLOR_GREEN : i === activeIdx ? '#0366d6' : 'var(--blue)'} stroke={i === activeIdx ? 'white' : 'none'} strokeWidth={1.5} />)}
    </svg>
  );
}

// ── Main ─────────────────────────────────────────────────────────────

export default function ProofGraph() {
  const { data: declData, isLoading } = useProofGraphDeclarations();
  const { data: timelineData } = useProofGraphTimeline();
  const [selNode, setSelNode] = useState('');
  const [selTimeIdx, setSelTimeIdx] = useState(-1); // -1 = current
  const [codeOpen, setCodeOpen] = useState(true);

  const selIter = selTimeIdx >= 0 && timelineData ? timelineData[selTimeIdx]?.iteration : '';
  const { data: snapData } = useProofGraphSnapshot(selIter);

  // Active data source
  const activeData: DeclarationsResponse | undefined = selIter && snapData ? snapData : declData;

  // Touched set: files present in the selected iteration's snapshots
  const touchedSet = useMemo(() => {
    const s = new Set<string>();
    if (!timelineData || timelineData.length === 0) return s;
    const idx = selTimeIdx >= 0 ? selTimeIdx : timelineData.length - 1;
    const pt = timelineData[idx];
    if (pt) { for (const f of Object.keys(pt.perFile)) s.add(f); for (const k of Object.keys(pt.perDeclaration)) s.add(k); }
    return s;
  }, [timelineData, selTimeIdx]);

  // Node detail: iteration-aware
  const selFile = selNode.split('::')[0] || '';
  const selName = selNode.split('::')[1] || '';
  const { data: nodeDetail } = useProofGraphNodeDetail(selFile, selName, selIter || undefined);

  // Layout
  const layout = useMemo(() => {
    if (!activeData) return null;
    return computeLayout(activeData.declarations, activeData.edges, activeData.files, touchedSet);
  }, [activeData, touchedSet]);

  const { ref: containerRef, tx, ty, scale, zoomIn, zoomOut, resetView } = useZoomPan(layout?.w ?? 0, layout?.h ?? 0);

  // Summary
  const summary = useMemo(() => {
    if (!layout) return null;
    let solved = 0, orange = 0, red = 0;
    for (const n of layout.nodes) { if (!n.decl.hasSorry) solved++; else if (n.touched) orange++; else red++; }
    return { solved, orange, red };
  }, [layout]);

  const blockedCount = useMemo(() => {
    if (!layout) return 0;
    const s = new Set<string>();
    for (const e of layout.edges) { if (e.blocked && e.from.decl.hasSorry) s.add(e.from.id); }
    return s.size;
  }, [layout]);

  // Highlighted edges
  const hlEdges = useMemo(() => {
    if (!layout || !selNode) return new Set<string>();
    const s = new Set<string>();
    for (const e of layout.edges) { if (e.from.id === selNode || e.to.id === selNode) s.add(`${e.from.id}->${e.to.id}`); }
    return s;
  }, [layout, selNode]);

  // Per-node sparkline
  const sparkline = useMemo(() => {
    if (!timelineData || !selNode) return null;
    const d: number[] = [];
    for (const pt of timelineData) {
      const e = pt.perDeclaration[selNode];
      if (e) { d.push(e.sorryCount); continue; }
      const f = selNode.split('::')[0];
      let found = false;
      for (const [k, v] of Object.entries(pt.perDeclaration)) { if (k.split('::')[1] === selNode.split('::')[1] && k.startsWith(f)) { d.push(v.sorryCount); found = true; break; } }
      if (!found) d.push(0);
    }
    return d.length > 1 ? d : null;
  }, [timelineData, selNode]);

  const timelineMax = useMemo(() => timelineData ? Math.max(...timelineData.map(t => t.totalSorry), 1) : 1, [timelineData]);

  const codeLines = useMemo(() => nodeDetail?.declaration?.body?.split('\n') ?? [], [nodeDetail]);
  const hlCode = useMemo(() => highlightLeanLines(codeLines), [codeLines]);

  const clickNode = useCallback((id: string) => { setSelNode(p => p === id ? '' : id); setCodeOpen(true); }, []);
  const clickTimeline = useCallback((i: number) => { setSelTimeIdx(p => p === i ? -1 : i); }, []);

  if (isLoading) return <div className={styles.loading}>Loading proof graph…</div>;
  if (!declData || declData.declarations.length === 0) return <div className={styles.page}><div className={styles.empty}><h3>No declarations found</h3><p>No .lean files with theorem/lemma declarations</p></div></div>;
  if (!layout) return null;

  const isSnap = selTimeIdx >= 0;
  const viewLabel = isSnap && timelineData ? timelineData[selTimeIdx].iteration.replace('iter-', 'Iteration #') : 'Current state';

  return (
    <div className={styles.page}>
      {/* Banner */}
      <div className={styles.banner}>
        <span className={styles.viewLabel}>{viewLabel}</span>
        {summary && (<>
          {summary.red > 0 && <span className={`${styles.chip} ${styles.chipRed}`}><span className={styles.dot} style={{ background: COLOR_RED }} />{summary.red} stuck</span>}
          {blockedCount > 0 && <span className={`${styles.chip} ${styles.chipOrange}`}><span className={styles.dot} style={{ background: COLOR_ORANGE }} />{blockedCount} blocked</span>}
          {summary.orange > 0 && <span className={`${styles.chip} ${styles.chipOrange}`}><span className={styles.dot} style={{ background: COLOR_ORANGE }} />{summary.orange} in progress</span>}
          {summary.solved > 0 && <span className={`${styles.chip} ${styles.chipGreen}`}><span className={styles.dot} style={{ background: COLOR_GREEN }} />{summary.solved} solved</span>}
        </>)}
        <div className={styles.zoom}>
          <button className={styles.zbtn} onClick={zoomOut}>−</button>
          <button className={styles.zbtn} onClick={resetView}>⟲</button>
          <button className={styles.zbtn} onClick={zoomIn}>+</button>
          <span className={styles.zscale}>{Math.round(scale * 100)}%</span>
        </div>
      </div>

      {/* Legend */}
      <div className={styles.legend}>
        <span className={styles.li}><span className={styles.ld} style={{ background: COLOR_GREEN }} />Solved</span>
        <span className={styles.li}><span className={styles.ld} style={{ background: COLOR_ORANGE }} />Sorry (worked on)</span>
        <span className={styles.li}><span className={styles.ld} style={{ background: COLOR_RED }} />Sorry (stale)</span>
        <span className={styles.li}><svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={COLOR_RED} strokeDasharray="3 2" strokeWidth="1.5" /></svg>Blocked dep</span>
      </div>

      {/* Main */}
      <div className={styles.main}>
        {/* Graph */}
        <div className={styles.gc} ref={containerRef}>
          <svg className={styles.svg} width={layout.w} height={layout.h}
            style={{ transform: `translate(${tx}px,${ty}px) scale(${scale})`, transformOrigin: '0 0' }}>
            <defs>
              <marker id="ga" markerWidth="5" markerHeight="4" refX="5" refY="2" orient="auto"><polygon points="0 0,5 2,0 4" fill="var(--border)" /></marker>
              <marker id="gb" markerWidth="5" markerHeight="4" refX="5" refY="2" orient="auto"><polygon points="0 0,5 2,0 4" fill={COLOR_RED} /></marker>
            </defs>

            {/* File groups as rounded rects */}
            {layout.groups.map(g => (
              <g key={g.file}>
                <rect x={g.hx} y={g.hy} width={g.hw} height={g.hh} rx={10} ry={10} fill={FILLS[g.colorIdx]} stroke={STROKES[g.colorIdx]} strokeWidth={1.5} />
                <text x={g.hx + 8} y={g.hy + 14} fontSize="10" fontWeight="600" fill="var(--text-muted)" fontFamily="var(--font-mono)">{g.file}</text>
              </g>
            ))}

            {/* Edges */}
            {layout.edges.map((e, i) => {
              const k = `${e.from.id}->${e.to.id}`;
              const hl = hlEdges.has(k);
              const x1 = e.from.x + e.from.w / 2, y1 = e.from.y + e.from.h / 2;
              const x2 = e.to.x + e.to.w / 2, y2 = e.to.y + e.to.h / 2;
              const dx = x2 - x1, dy = y2 - y1;
              const cx = (x1 + x2) / 2 - dy * 0.12, cy = (y1 + y2) / 2 + dx * 0.12;
              return <path key={i} d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`} fill="none"
                stroke={hl ? 'var(--blue)' : e.blocked ? COLOR_RED : 'var(--border)'}
                strokeWidth={hl ? 2 : 1} strokeDasharray={e.blocked && !hl ? '4 3' : 'none'}
                opacity={hl ? 0.9 : e.blocked ? 0.5 : 0.3} markerEnd={e.blocked ? 'url(#gb)' : 'url(#ga)'} />;
            })}

            {/* Nodes */}
            {layout.nodes.map(n => {
              const sel = n.id === selNode;
              const att = n.decl.totalAttempts ?? 0;
              const ms = n.decl.latestMilestoneStatus;
              return (
                <g key={n.id} data-node="1" onClick={() => clickNode(n.id)} style={{ cursor: 'pointer' }}>
                  {att > 3 && <rect x={n.x - 2} y={n.y - 2} width={n.w + 4} height={n.h + 4} rx={8} fill="none" stroke={n.color} strokeWidth={1.5} opacity={0.3} />}
                  <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} fill="var(--bg-primary)" stroke={sel ? 'var(--blue)' : n.color} strokeWidth={sel ? 2.5 : 1.5} />
                  <text x={n.x + 5} y={n.y + 12} fontSize="8" fontWeight="700" fill={n.color} fontFamily="var(--font-sans)">{n.decl.kind.toUpperCase()}</text>
                  <text x={n.x + 5} y={n.y + 25} fontSize="10.5" fontWeight="500" fill="var(--text-primary)" fontFamily="var(--font-mono)">
                    {n.decl.name.length > 19 ? n.decl.name.slice(0, 18) + '…' : n.decl.name}
                  </text>
                  {(att > 0 || ms) && <text x={n.x + 5} y={n.y + 36} fontSize="8" fill="var(--text-muted)" fontFamily="var(--font-mono)">{att > 0 ? `${att} att` : ''}{att > 0 && ms ? ' · ' : ''}{ms || ''}</text>}
                  {n.decl.hasSorry && (<>
                    <rect x={n.x + n.w - 26} y={n.y + 3} width={20} height={12} rx={6} fill={n.color} opacity={0.15} />
                    <text x={n.x + n.w - 16} y={n.y + 12} fontSize="8" fontWeight="700" fill={n.color} textAnchor="middle" fontFamily="var(--font-mono)">{n.decl.sorryCount}s</text>
                  </>)}
                  {!n.decl.hasSorry && <text x={n.x + n.w - 14} y={n.y + 13} fill={COLOR_GREEN} fontSize="10" fontWeight="700">✓</text>}
                </g>
              );
            })}
          </svg>
        </div>

        {/* Sidebar */}
        <div className={styles.side}>
          {!selNode ? (
            <div className={styles.sideEmpty}>Click a node to see code, milestones, and attempts{isSnap ? ` at ${viewLabel}` : ''}</div>
          ) : (<>
            <div className={styles.sideHead}>
              <div className={styles.sideName}>{selName}</div>
              <div className={styles.sideFile}>{selFile}:{nodeDetail?.declaration?.line ?? '?'}</div>
              {isSnap && <div className={styles.sideIterTag}>Code at {viewLabel}</div>}
              <div className={styles.sideMeta}>
                {nodeDetail?.declaration && <span className={styles.badge} style={{ color: nodeDetail.declaration.hasSorry ? COLOR_RED : COLOR_GREEN, borderColor: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.3)' : 'rgba(40,167,69,0.3)', background: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.06)' : 'rgba(40,167,69,0.06)' }}>{nodeDetail.declaration.hasSorry ? `${nodeDetail.declaration.sorryCount} sorry` : 'solved'}</span>}
                {nodeDetail?.declaration && <span className={styles.badge} style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>{nodeDetail.declaration.kind}</span>}
                {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && <span className={styles.badge} style={{ color: 'var(--blue)', borderColor: 'rgba(3,102,214,0.3)', background: 'rgba(3,102,214,0.06)' }}>{nodeDetail.milestones.length} session{nodeDetail.milestones.length > 1 ? 's' : ''}</span>}
              </div>
            </div>

            {sparkline && <div className={styles.spark}><div className={styles.sparkLabel}>Sorry count across iterations</div><Sparkline data={sparkline} activeIdx={selTimeIdx >= 0 ? selTimeIdx : undefined} /></div>}

            <div className={styles.codeSection}>
              <div className={styles.codeHeader} onClick={() => setCodeOpen(!codeOpen)}>{codeOpen ? '▾' : '▸'} Code {codeLines.length > 0 ? `(${codeLines.length} lines)` : ''}</div>
              {codeOpen && codeLines.length > 0 && <div className={styles.codeBlock}>{codeLines.map((l, i) => <div key={i}><LeanCodeLine text={l} tokens={hlCode[i]} /></div>)}</div>}
            </div>

            {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && (
              <div className={styles.msSection}>
                <div className={styles.msLabel}>Milestone history{isSnap ? ` (up to ${viewLabel})` : ''}</div>
                {nodeDetail.milestones.map((m, i) => (
                  <div key={i} className={styles.msEntry} style={{ borderLeftColor: STATUS_COLORS[m.status] || 'var(--border)' }}>
                    <div className={styles.msHead}>
                      <span className={styles.msSess}>{m.sessionId.replace('session_', '#')}</span>
                      <span style={{ fontWeight: 600, color: STATUS_COLORS[m.status] || 'var(--text-muted)' }}>{m.status}</span>
                    </div>
                    {m.blocker && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 3 }}>Blocker: {m.blocker}</div>}
                    {m.nextSteps && <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 3, fontStyle: 'italic' }}>Next: {m.nextSteps}</div>}
                    {m.keyLemmas && m.keyLemmas.length > 0 && <div style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', marginTop: 2 }}>Lemmas: {m.keyLemmas.join(', ')}</div>}
                    {Array.isArray(m.attempts) && m.attempts.length > 0 && <div className={styles.msAttempts}>{(m.attempts as any[]).map((a, ai) => <AttemptCard key={ai} att={a} />)}</div>}
                  </div>
                ))}
              </div>
            )}
          </>)}
        </div>
      </div>

      {/* Timeline */}
      {timelineData && timelineData.length > 0 && (
        <div className={styles.tl}>
          <div className={styles.tlHead}>
            <span className={styles.tlTitle}>Sorry count per iteration (click to travel in time)</span>
            {isSnap && <button className={styles.tlReset} onClick={() => setSelTimeIdx(-1)}>← Current</button>}
          </div>
          <div className={styles.tlChart}>
            {timelineData.map((pt, i) => {
              const pct = (pt.totalSorry / timelineMax) * 100;
              const active = i === selTimeIdx;
              return <div key={i} className={`${styles.tlBar} ${active ? styles.tlBarActive : ''}`}
                style={{ height: `${Math.max(pct, 5)}%`, background: pt.totalSorry === 0 ? COLOR_GREEN : COLOR_ORANGE, opacity: active ? 1 : 0.5 }}
                onClick={() => clickTimeline(i)} title={`${pt.iteration}: ${pt.totalSorry} sorry`}>
                <span className={styles.tlBarNum}>{pt.totalSorry}</span>
              </div>;
            })}
          </div>
          <div className={styles.tlLabels}>
            {timelineData.map((pt, i) => <div key={i} className={`${styles.tlLbl} ${i === selTimeIdx ? styles.tlLblActive : ''}`}>{pt.iteration.replace('iter-', '#')}</div>)}
          </div>
        </div>
      )}
    </div>
  );
}