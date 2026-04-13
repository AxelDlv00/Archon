/**
 * ProofGraph v5
 *
 * Fixes:
 *   - Zoom 5x faster (base 1.01 instead of 1.002)
 *   - Orange/red computed from changedDeclarations (actual body diffs), not perDeclaration
 *   - File group labels show basename only
 *   - No flash on timeline switch: keepPreviousData + don't fall through to declData while loading
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  useProofGraphDeclarations, useProofGraphTimeline, useProofGraphSnapshot, useProofGraphNodeDetail,
  type GraphDeclaration, type DeclarationsResponse,
} from '../hooks/useProofGraph';
import { STATUS_COLORS } from '../utils/constants';
import AttemptCard from '../components/AttemptCard';
import LeanCodeLine from '../components/LeanCodeLine';
import { highlightLeanLines } from '../utils/leanHighlight';
import styles from './ProofGraph.module.css';

const C_GREEN = '#28a745', C_ORANGE = '#e36209', C_RED = '#cb2431';
function ncolor(sorry: boolean, touched: boolean) { return sorry ? (touched ? C_ORANGE : C_RED) : C_GREEN; }

/** Extract filename from path: "Foo/Bar/Baz.lean" -> "Baz.lean" */
function basename(p: string) { const i = p.lastIndexOf('/'); return i >= 0 ? p.slice(i + 1) : p; }

// ── Layout ───────────────────────────────────────────────────────────

interface LN { id: string; d: GraphDeclaration; x: number; y: number; w: number; h: number; c: string; t: boolean; }
interface LG { file: string; label: string; x: number; y: number; w: number; h: number; ci: number; }
interface LE { from: LN; to: LN; blocked: boolean; }

const NW = 170, NH = 42, NG = 8, GP = 14, GH = 20, GG = 22;
const BG = ['rgba(3,102,214,0.06)','rgba(111,66,193,0.06)','rgba(227,98,9,0.06)','rgba(40,167,69,0.06)','rgba(203,36,49,0.06)','rgba(0,134,114,0.06)'];
const BS = ['rgba(3,102,214,0.22)','rgba(111,66,193,0.22)','rgba(227,98,9,0.22)','rgba(40,167,69,0.22)','rgba(203,36,49,0.22)','rgba(0,134,114,0.22)'];

function doLayout(decls: GraphDeclaration[], edgeList: { from: string; to: string }[], files: { file: string }[], changed: Set<string>) {
  const nm = new Map<string, LN>(); const gs: LG[] = [];
  const af = files.filter(f => decls.some(d => d.file === f.file));
  if (!af.length) return { n: [] as LN[], g: gs, e: [] as LE[], w: 400, h: 400 };
  const cols = Math.max(1, Math.round(Math.sqrt(af.length * 1.3)));
  let gx = GG, gy = GG, col = 0, rowH = 0;
  for (let fi = 0; fi < af.length; fi++) {
    const fd = decls.filter(d => d.file === af[fi].file); if (!fd.length) continue;
    const ic = fd.length > 6 ? 2 : 1, pc = Math.ceil(fd.length / ic);
    const gw = ic * NW + (ic - 1) * NG + GP * 2, gh = GH + pc * (NH + NG) - NG + GP;
    for (let di = 0; di < fd.length; di++) {
      const d = fd[di], c = Math.floor(di / pc), r = di % pc;
      const x = gx + GP + c * (NW + NG), y = gy + GH + r * (NH + NG);
      const t = changed.has(d.id);
      nm.set(d.id, { id: d.id, d, x, y, w: NW, h: NH, c: ncolor(d.hasSorry, t), t });
    }
    gs.push({ file: af[fi].file, label: basename(af[fi].file), x: gx, y: gy, w: gw, h: gh, ci: fi % BG.length });
    rowH = Math.max(rowH, gh); col++;
    if (col >= cols) { col = 0; gx = GG; gy += rowH + GG; rowH = 0; } else { gx += gw + GG; }
  }
  const es: LE[] = [];
  for (const e of edgeList) { const f = nm.get(e.from), t = nm.get(e.to); if (f && t) es.push({ from: f, to: t, blocked: t.d.hasSorry }); }
  return { n: Array.from(nm.values()), g: gs, e: es, w: Math.max(...gs.map(g => g.x + g.w), 400) + GG, h: Math.max(...gs.map(g => g.y + g.h), 400) + GG };
}

// ── ViewBox zoom/pan ─────────────────────────────────────────────────

function useViewBox(cw: number, ch: number) {
  const svgRef = useRef<SVGSVGElement>(null);
  const cRef = useRef<HTMLDivElement>(null);
  const [vb, setVb] = useState<[number, number, number, number]>([0, 0, 800, 600]);
  const drag = useRef(false);
  const last = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = cRef.current;
    if (!el || cw <= 0 || ch <= 0) return;
    const r = el.getBoundingClientRect();
    const s = Math.max(cw / r.width, ch / r.height) / 0.92;
    const vw = r.width * s, vh = r.height * s;
    setVb([cw / 2 - vw / 2, ch / 2 - vh / 2, vw, vh]);
  }, [cw, ch]);

  useEffect(() => {
    const el = cRef.current; if (!el) return;
    const MIN = 0.2, MAX = 5;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault(); e.stopPropagation();
      const rect = el.getBoundingClientRect();
      const fx = (e.clientX - rect.left) / rect.width, fy = (e.clientY - rect.top) / rect.height;
      setVb(([vx, vy, vw, vh]) => {
        if (e.ctrlKey || e.metaKey) {
          // FASTER zoom: base 1.01 instead of 1.002
          const factor = Math.pow(1.01, e.deltaY);
          const nw = Math.max(cw * MIN, Math.min(cw * MAX, vw * factor));
          const nh = Math.max(ch * MIN, Math.min(ch * MAX, vh * factor));
          return [vx + (vw - nw) * fx, vy + (vh - nh) * fy, nw, nh];
        } else {
          const sx = vw / rect.width, sy = vh / rect.height;
          return [vx + e.deltaX * sx, vy + e.deltaY * sy, vw, vh];
        }
      });
    };
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || (e.target as HTMLElement).closest('[data-node]')) return;
      drag.current = true; last.current = { x: e.clientX, y: e.clientY }; el.style.cursor = 'grabbing'; e.preventDefault();
    };
    const onMove = (e: MouseEvent) => {
      if (!drag.current) return;
      const dx = e.clientX - last.current.x, dy = e.clientY - last.current.y;
      last.current = { x: e.clientX, y: e.clientY };
      setVb(([vx, vy, vw, vh]) => { const r = cRef.current?.getBoundingClientRect(); if (!r) return [vx, vy, vw, vh]; return [vx - dx * vw / r.width, vy - dy * vh / r.height, vw, vh]; });
    };
    const onUp = () => { drag.current = false; el.style.cursor = 'grab'; };
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => { el.removeEventListener('wheel', onWheel); el.removeEventListener('mousedown', onDown); window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp); };
  }, [cw, ch]);

  const zoomBy = useCallback((f: number) => {
    setVb(([vx, vy, vw, vh]) => { const nw = Math.max(cw * 0.2, Math.min(cw * 5, vw * f)), nh = Math.max(ch * 0.2, Math.min(ch * 5, vh * f)); return [vx + (vw - nw) / 2, vy + (vh - nh) / 2, nw, nh]; });
  }, [cw, ch]);
  const reset = useCallback(() => {
    const el = cRef.current; if (!el || cw <= 0 || ch <= 0) return;
    const r = el.getBoundingClientRect(); const s = Math.max(cw / r.width, ch / r.height) / 0.92;
    const vw = r.width * s, vh = r.height * s; setVb([cw / 2 - vw / 2, ch / 2 - vh / 2, vw, vh]);
  }, [cw, ch]);
  const scale = cw > 0 && vb[2] > 0 ? cw / vb[2] : 1;

  return { svgRef, cRef, vb, zoomIn: () => zoomBy(0.7), zoomOut: () => zoomBy(1.4), reset, scale };
}

// ── Sparkline ────────────────────────────────────────────────────────

function Spark({ data, ai, w = 280, h = 34 }: { data: number[]; ai?: number; w?: number; h?: number }) {
  if (data.length < 2) return null;
  const mx = Math.max(...data, 1), sx = w / (data.length - 1);
  const pts = data.map((v, i) => `${i * sx},${h - (v / mx) * (h - 4)}`).join(' ');
  return <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: 'block' }}>
    <polygon points={`0,${h} ${pts} ${(data.length - 1) * sx},${h}`} fill="rgba(3,102,214,0.08)" />
    <polyline points={pts} fill="none" stroke="var(--blue)" strokeWidth="1.5" />
    {data.map((v, i) => <circle key={i} cx={i * sx} cy={h - (v / mx) * (h - 4)} r={i === ai ? 4 : 2} fill={v === 0 ? C_GREEN : i === ai ? '#0366d6' : 'var(--blue)'} stroke={i === ai ? 'white' : 'none'} strokeWidth={1.5} />)}
  </svg>;
}

// ── Main ─────────────────────────────────────────────────────────────

export default function ProofGraph() {
  const { data: declData, isLoading } = useProofGraphDeclarations();
  const { data: tlData } = useProofGraphTimeline();
  const [selNode, setSelNode] = useState('');
  const [selTl, setSelTl] = useState(-1);
  const [codeOpen, setCodeOpen] = useState(true);

  const selIter = selTl >= 0 && tlData ? tlData[selTl]?.iteration : '';
  const { data: snapData, isFetching: snapLoading } = useProofGraphSnapshot(selIter);

  // Active data: when viewing a snapshot, use snapData. Don't fall through to declData while loading.
  // placeholderData in the hook keeps the previous snapshot visible during load.
  const activeData: DeclarationsResponse | undefined = selIter
    ? (snapData ?? undefined) // snapData holds previous value via placeholderData while loading
    : declData;

  // Changed set: declarations whose body actually changed at this timeline point
  const changedSet = useMemo(() => {
    const s = new Set<string>();
    if (!tlData?.length) return s;
    const idx = selTl >= 0 ? selTl : tlData.length - 1;
    const pt = tlData[idx];
    if (pt?.changedDeclarations) {
      for (const id of pt.changedDeclarations) s.add(id);
    }
    return s;
  }, [tlData, selTl]);

  const selFile = selNode.split('::')[0] || '', selName = selNode.split('::')[1] || '';
  const { data: nd } = useProofGraphNodeDetail(selFile, selName, selIter || undefined);

  const lo = useMemo(() => activeData ? doLayout(activeData.declarations, activeData.edges, activeData.files, changedSet) : null, [activeData, changedSet]);
  const { svgRef, cRef, vb, zoomIn, zoomOut, reset, scale } = useViewBox(lo?.w ?? 0, lo?.h ?? 0);

  const summary = useMemo(() => {
    if (!lo) return null;
    let s = 0, o = 0, r = 0;
    for (const n of lo.n) { if (!n.d.hasSorry) s++; else if (n.t) o++; else r++; }
    return { s, o, r };
  }, [lo]);

  const hlEdges = useMemo(() => {
    if (!lo || !selNode) return new Set<string>();
    const s = new Set<string>();
    for (const e of lo.e) { if (e.from.id === selNode || e.to.id === selNode) s.add(`${e.from.id}->${e.to.id}`); }
    return s;
  }, [lo, selNode]);

  const spark = useMemo(() => {
    if (!tlData || !selNode) return null;
    const d: number[] = [];
    for (const pt of tlData) {
      const e = pt.perDeclaration[selNode]; if (e) { d.push(e.sorryCount); continue; }
      const f = selNode.split('::')[0], n = selNode.split('::')[1];
      let found = false;
      for (const [k, v] of Object.entries(pt.perDeclaration)) { if (k.split('::')[1] === n && k.startsWith(f)) { d.push(v.sorryCount); found = true; break; } }
      if (!found) d.push(0);
    }
    return d.length > 1 ? d : null;
  }, [tlData, selNode]);

  const tlMax = useMemo(() => tlData ? Math.max(...tlData.map(t => t.totalSorry), 1) : 1, [tlData]);
  const codeLines = useMemo(() => nd?.declaration?.body?.split('\n') ?? [], [nd]);
  const hlCode = useMemo(() => highlightLeanLines(codeLines), [codeLines]);
  const clickNode = useCallback((id: string) => { setSelNode(p => p === id ? '' : id); setCodeOpen(true); }, []);

  if (isLoading) return <div className={styles.loading}>Loading…</div>;
  if (!declData?.declarations?.length) return <div className={styles.page}><div className={styles.empty}><h3>No declarations</h3><p>No .lean files with declarations</p></div></div>;
  if (!lo) return null;

  const isSnap = selTl >= 0;
  const viewLabel = isSnap && tlData ? tlData[selTl].iteration.replace('iter-', 'Iter #') : 'Current';

  return (
    <div className={styles.page}>
      <div className={styles.banner}>
        <span className={styles.viewLabel}>{viewLabel}{snapLoading && isSnap ? ' (loading…)' : ''}</span>
        {summary && (<>
          {summary.r > 0 && <span className={`${styles.chip} ${styles.chipRed}`}><span className={styles.dot} style={{ background: C_RED }} />{summary.r} stuck</span>}
          {summary.o > 0 && <span className={`${styles.chip} ${styles.chipOrange}`}><span className={styles.dot} style={{ background: C_ORANGE }} />{summary.o} in progress</span>}
          {summary.s > 0 && <span className={`${styles.chip} ${styles.chipGreen}`}><span className={styles.dot} style={{ background: C_GREEN }} />{summary.s} solved</span>}
        </>)}
        <div className={styles.zoom}>
          <button className={styles.zbtn} onClick={zoomOut}>−</button>
          <button className={styles.zbtn} onClick={reset}>⟲</button>
          <button className={styles.zbtn} onClick={zoomIn}>+</button>
          <span className={styles.zscale}>{Math.round(scale * 100)}%</span>
        </div>
      </div>

      <div className={styles.legend}>
        <span className={styles.li}><span className={styles.ld} style={{ background: C_GREEN }} />Solved</span>
        <span className={styles.li}><span className={styles.ld} style={{ background: C_ORANGE }} />Sorry (code changed)</span>
        <span className={styles.li}><span className={styles.ld} style={{ background: C_RED }} />Sorry (code unchanged)</span>
        <span className={styles.li}><svg width="18" height="8"><line x1="0" y1="4" x2="18" y2="4" stroke={C_RED} strokeDasharray="3 2" strokeWidth="1.5" /></svg>Blocked</span>
      </div>

      <div className={styles.main}>
        <div className={styles.gc} ref={cRef}>
          <svg ref={svgRef} className={styles.svg} viewBox={`${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}`} preserveAspectRatio="xMidYMid meet" width="100%" height="100%">
            <defs>
              <marker id="ga" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0,6 2,0 4" fill="var(--border)" /></marker>
              <marker id="gb" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0,6 2,0 4" fill={C_RED} /></marker>
              <marker id="ghl" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0,6 2,0 4" fill="var(--blue)" /></marker>
            </defs>
            {/* File groups */}
            {lo.g.map(g => <g key={g.file}>
              <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={10} ry={10} fill={BG[g.ci]} stroke={BS[g.ci]} strokeWidth={1.5} />
              <text x={g.x + 8} y={g.y + 14} fontSize="10" fontWeight="600" fill="var(--text-muted)" fontFamily="var(--font-mono)">{g.label}</text>
            </g>)}
            {/* Nodes */}
            {lo.n.map(n => {
              const sel = n.id === selNode, att = n.d.totalAttempts ?? 0, ms = n.d.latestMilestoneStatus;
              return <g key={n.id} data-node="1" onClick={() => clickNode(n.id)} style={{ cursor: 'pointer' }}>
                {att > 3 && <rect x={n.x - 2} y={n.y - 2} width={n.w + 4} height={n.h + 4} rx={8} fill="none" stroke={n.c} strokeWidth={1.5} opacity={0.3} />}
                <rect x={n.x} y={n.y} width={n.w} height={n.h} rx={6} fill="var(--bg-primary)" stroke={sel ? 'var(--blue)' : n.c} strokeWidth={sel ? 2.5 : 1.5} />
                <text x={n.x + 5} y={n.y + 12} fontSize="8" fontWeight="700" fill={n.c} fontFamily="var(--font-sans)">{n.d.kind.toUpperCase()}</text>
                <text x={n.x + 5} y={n.y + 25} fontSize="10.5" fontWeight="500" fill="var(--text-primary)" fontFamily="var(--font-mono)">{n.d.name.length > 19 ? n.d.name.slice(0, 18) + '…' : n.d.name}</text>
                {(att > 0 || ms) && <text x={n.x + 5} y={n.y + 36} fontSize="8" fill="var(--text-muted)" fontFamily="var(--font-mono)">{att > 0 ? `${att} att` : ''}{att > 0 && ms ? ' · ' : ''}{ms || ''}</text>}
                {n.d.hasSorry ? <><rect x={n.x + n.w - 26} y={n.y + 3} width={20} height={12} rx={6} fill={n.c} opacity={0.15} /><text x={n.x + n.w - 16} y={n.y + 12} fontSize="8" fontWeight="700" fill={n.c} textAnchor="middle" fontFamily="var(--font-mono)">{n.d.sorryCount}s</text></> : <text x={n.x + n.w - 14} y={n.y + 13} fill={C_GREEN} fontSize="10" fontWeight="700">✓</text>}
              </g>;
            })}
            {/* Edges ON TOP */}
            {lo.e.map((e, i) => {
              const k = `${e.from.id}->${e.to.id}`, hl = hlEdges.has(k);
              const sg = e.from.d.file === e.to.d.file;
              let x1: number, y1: number, x2: number, y2: number;
              if (sg) { x1 = e.from.x + e.from.w / 2; y1 = e.from.y + e.from.h; x2 = e.to.x + e.to.w / 2; y2 = e.to.y; }
              else { x1 = e.from.x + e.from.w; y1 = e.from.y + e.from.h / 2; x2 = e.to.x; y2 = e.to.y + e.to.h / 2; }
              const dx = x2 - x1, dy = y2 - y1;
              const cx = (x1 + x2) / 2 + (sg ? 30 : -dy * 0.1), cy = (y1 + y2) / 2 + (sg ? 0 : dx * 0.1);
              return <path key={i} d={`M${x1},${y1} Q${cx},${cy} ${x2},${y2}`} fill="none"
                stroke={hl ? 'var(--blue)' : e.blocked ? C_RED : 'var(--border)'}
                strokeWidth={hl ? 2.5 : 1.2} strokeDasharray={e.blocked && !hl ? '5 3' : 'none'}
                opacity={hl ? 1 : e.blocked ? 0.6 : 0.35}
                markerEnd={hl ? 'url(#ghl)' : e.blocked ? 'url(#gb)' : 'url(#ga)'}
                style={{ pointerEvents: 'none' }} />;
            })}
          </svg>
        </div>

        <div className={styles.side}>
          {!selNode ? <div className={styles.sideEmpty}>Click a node to inspect{isSnap ? ` (at ${viewLabel})` : ''}</div> : <>
            <div className={styles.sideHead}>
              <div className={styles.sideName}>{selName}</div>
              <div className={styles.sideFile}>{selFile}:{nd?.declaration?.line ?? '?'}</div>
              {isSnap && <div className={styles.sideIterTag}>Code at {viewLabel}</div>}
              <div className={styles.sideMeta}>
                {nd?.declaration && <span className={styles.badge} style={{ color: nd.declaration.hasSorry ? C_RED : C_GREEN, borderColor: nd.declaration.hasSorry ? 'rgba(203,36,49,0.3)' : 'rgba(40,167,69,0.3)', background: nd.declaration.hasSorry ? 'rgba(203,36,49,0.06)' : 'rgba(40,167,69,0.06)' }}>{nd.declaration.hasSorry ? `${nd.declaration.sorryCount} sorry` : 'solved'}</span>}
                {nd?.declaration && <span className={styles.badge} style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>{nd.declaration.kind}</span>}
                {nd?.milestones?.length ? <span className={styles.badge} style={{ color: 'var(--blue)', borderColor: 'rgba(3,102,214,0.3)', background: 'rgba(3,102,214,0.06)' }}>{nd.milestones.length} session{nd.milestones.length > 1 ? 's' : ''}</span> : null}
              </div>
            </div>
            {spark && <div className={styles.spark}><div className={styles.sparkLabel}>Sorry across iterations</div><Spark data={spark} ai={selTl >= 0 ? selTl : undefined} /></div>}
            <div className={styles.codeSection}>
              <div className={styles.codeHeader} onClick={() => setCodeOpen(!codeOpen)}>{codeOpen ? '▾' : '▸'} Code {codeLines.length > 0 ? `(${codeLines.length} lines)` : ''}</div>
              {codeOpen && codeLines.length > 0 && <div className={styles.codeBlock}>{codeLines.map((l, i) => <div key={i}><LeanCodeLine text={l} tokens={hlCode[i]} /></div>)}</div>}
            </div>
            {nd?.milestones?.length ? <div className={styles.msSection}>
              <div className={styles.msLabel}>Milestones{isSnap ? ` (up to ${viewLabel})` : ''}</div>
              {nd.milestones.map((m, i) => <div key={i} className={styles.msEntry} style={{ borderLeftColor: STATUS_COLORS[m.status] || 'var(--border)' }}>
                <div className={styles.msHead}><span className={styles.msSess}>{m.sessionId.replace('session_', '#')}</span><span style={{ fontWeight: 600, color: STATUS_COLORS[m.status] || 'var(--text-muted)' }}>{m.status}</span></div>
                {m.blocker && <div style={{ color: 'var(--red)', fontSize: 11, marginTop: 3 }}>Blocker: {m.blocker}</div>}
                {m.nextSteps && <div style={{ color: 'var(--text-secondary)', fontSize: 11, marginTop: 3, fontStyle: 'italic' }}>Next: {m.nextSteps}</div>}
                {m.keyLemmas?.length ? <div style={{ color: 'var(--text-muted)', fontSize: 10, fontFamily: 'var(--font-mono)', marginTop: 2 }}>Lemmas: {m.keyLemmas.join(', ')}</div> : null}
                {Array.isArray(m.attempts) && m.attempts.length > 0 && <div className={styles.msAttempts}>{(m.attempts as any[]).map((a, j) => <AttemptCard key={j} att={a} />)}</div>}
              </div>)}
            </div> : null}
          </>}
        </div>
      </div>

      {tlData && tlData.length > 0 && <div className={styles.tl}>
        <div className={styles.tlHead}>
          <span className={styles.tlTitle}>Sorry per iteration — click to time-travel</span>
          {isSnap && <button className={styles.tlReset} onClick={() => setSelTl(-1)}>← Current</button>}
        </div>
        <div className={styles.tlChart}>
          {tlData.map((pt, i) => {
            const pct = (pt.totalSorry / tlMax) * 100;
            return <div key={i} className={`${styles.tlBar} ${i === selTl ? styles.tlBarAct : ''}`}
              style={{ height: `${Math.max(pct, 5)}%`, background: pt.totalSorry === 0 ? C_GREEN : C_ORANGE, opacity: i === selTl ? 1 : 0.5 }}
              onClick={() => setSelTl(p => p === i ? -1 : i)} title={`${pt.iteration}: ${pt.totalSorry} sorry`}>
              <span className={styles.tlNum}>{pt.totalSorry}</span>
            </div>;
          })}
        </div>
        <div className={styles.tlLabels}>{tlData.map((pt, i) => <div key={i} className={`${styles.tlLbl} ${i === selTl ? styles.tlLblAct : ''}`}>{pt.iteration.replace('iter-', '#')}</div>)}</div>
      </div>}
    </div>
  );
}