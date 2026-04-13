/**
 * ProofGraph — Proof evolution visualization
 *
 * Features:
 *   - Trackpad zoom/pan (wheel + drag)
 *   - Radial file-group layout (files arranged in a circle, deps cross)
 *   - 3 colors: green (solved), orange (sorry, touched prev iter), red (sorry, untouched >1 iter)
 *   - Timeline = only iterations with snapshots (same as Diffs)
 *   - Clicking timeline changes graph to show state at that iteration
 *   - Attempt count + milestone status shown on nodes before clicking
 *   - Full code in sidebar (never truncated), journal-style attempts
 */
import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  useProofGraphDeclarations,
  useProofGraphTimeline,
  useProofGraphSnapshot,
  useProofGraphNodeDetail,
  type GraphDeclaration,
  type GraphEdge,
  type TimelinePoint,
  type DeclarationsResponse,
} from '../hooks/useProofGraph';
import { STATUS_COLORS } from '../utils/constants';
import AttemptCard from '../components/AttemptCard';
import LeanCodeLine from '../components/LeanCodeLine';
import { highlightLeanLines } from '../utils/leanHighlight';
import styles from './ProofGraph.module.css';

// ── 3 colors ─────────────────────────────────────────────────────────

const COLOR_GREEN  = '#28a745';
const COLOR_ORANGE = '#e36209';
const COLOR_RED    = '#cb2431';

/**
 * Determine node color based on the 3-color scheme:
 * - Green: no sorry (solved)
 * - Orange: has sorry but was touched in the previous iteration
 * - Red: has sorry and was NOT touched in the previous iteration (or untouched for >1 iter)
 */
function nodeColor(
  hasSorry: boolean,
  touchedInPrevIter: boolean,
): string {
  if (!hasSorry) return COLOR_GREEN;
  if (touchedInPrevIter) return COLOR_ORANGE;
  return COLOR_RED;
}

// ── Radial layout ────────────────────────────────────────────────────

interface LayoutNode {
  id: string;
  decl: GraphDeclaration;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  touchedPrev: boolean;
}

interface LayoutFileGroup {
  file: string;
  cx: number;
  cy: number;
  x: number;
  y: number;
  w: number;
  h: number;
  colorIdx: number;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  isBlocked: boolean;
}

const NODE_W = 190;
const NODE_H = 44;
const NODE_GAP_Y = 10;
const GROUP_PAD = 16;
const GROUP_HEADER = 22;

const FILE_FILLS = [
  'rgba(3, 102, 214, 0.05)', 'rgba(111, 66, 193, 0.05)', 'rgba(227, 98, 9, 0.05)',
  'rgba(40, 167, 69, 0.05)', 'rgba(203, 36, 49, 0.05)', 'rgba(0, 134, 114, 0.05)',
];
const FILE_STROKES = [
  'rgba(3, 102, 214, 0.18)', 'rgba(111, 66, 193, 0.18)', 'rgba(227, 98, 9, 0.18)',
  'rgba(40, 167, 69, 0.18)', 'rgba(203, 36, 49, 0.18)', 'rgba(0, 134, 114, 0.18)',
];

function computeRadialLayout(
  declarations: GraphDeclaration[],
  edges: GraphEdge[],
  files: { file: string; declarations: string[] }[],
  touchedSet: Set<string>,
): { nodes: LayoutNode[]; groups: LayoutFileGroup[]; edges: LayoutEdge[]; width: number; height: number } {
  const nodeMap = new Map<string, LayoutNode>();
  const groups: LayoutFileGroup[] = [];

  const fileCount = files.filter(f => declarations.some(d => d.file === f.file)).length;
  if (fileCount === 0) return { nodes: [], groups: [], edges: [], width: 600, height: 600 };

  // Compute max group height to determine ring radius
  const groupSizes = files.map(fg => declarations.filter(d => d.file === fg.file).length).filter(n => n > 0);
  const maxGroupH = Math.max(...groupSizes.map(n => GROUP_HEADER + n * (NODE_H + NODE_GAP_Y) + GROUP_PAD));
  const RADIUS = Math.max(300, fileCount * (NODE_W + 40) / (2 * Math.PI), maxGroupH * 1.2);
  const CX = RADIUS + NODE_W + 60;
  const CY = RADIUS + maxGroupH / 2 + 60;

  let fileIdx = 0;
  for (let fi = 0; fi < files.length; fi++) {
    const fg = files[fi];
    const fileDecls = declarations.filter(d => d.file === fg.file);
    if (fileDecls.length === 0) continue;

    const angle = (2 * Math.PI * fileIdx) / fileCount - Math.PI / 2;
    const groupCX = CX + RADIUS * Math.cos(angle);
    const groupCY = CY + RADIUS * Math.sin(angle);

    const groupH = GROUP_HEADER + fileDecls.length * (NODE_H + NODE_GAP_Y) + GROUP_PAD;
    const groupW = NODE_W + GROUP_PAD * 2;
    const groupX = groupCX - groupW / 2;
    const groupY = groupCY - groupH / 2;
    const colorIdx = fi % FILE_FILLS.length;

    for (let di = 0; di < fileDecls.length; di++) {
      const d = fileDecls[di];
      const x = groupX + GROUP_PAD;
      const y = groupY + GROUP_HEADER + di * (NODE_H + NODE_GAP_Y);
      const touched = touchedSet.has(d.id) || touchedSet.has(d.file);
      const color = nodeColor(d.hasSorry, touched);
      nodeMap.set(d.id, { id: d.id, decl: d, x, y, w: NODE_W, h: NODE_H, color, touchedPrev: touched });
    }

    groups.push({ file: fg.file, cx: groupCX, cy: groupCY, x: groupX, y: groupY, w: groupW, h: groupH, colorIdx });
    fileIdx++;
  }

  const layoutEdges: LayoutEdge[] = [];
  for (const e of edges) {
    const from = nodeMap.get(e.from);
    const to = nodeMap.get(e.to);
    if (from && to) layoutEdges.push({ from, to, isBlocked: to.decl.hasSorry });
  }

  const allNodes = Array.from(nodeMap.values());
  const totalW = (CX + RADIUS + NODE_W + 60) * 2;
  const totalH = (CY + RADIUS + maxGroupH / 2 + 60) * 2;
  return { nodes: allNodes, groups, edges: layoutEdges, width: Math.max(totalW, 800), height: Math.max(totalH, 800) };
}

// ── Zoom/Pan hook ────────────────────────────────────────────────────

function useZoomPan() {
  const containerRef = useRef<HTMLDivElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const isDragging = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        // Pinch zoom
        const delta = -e.deltaY * 0.005;
        setTransform(t => {
          const newScale = Math.max(0.1, Math.min(4, t.scale + delta * t.scale));
          const rect = el.getBoundingClientRect();
          const mx = e.clientX - rect.left;
          const my = e.clientY - rect.top;
          const ratio = newScale / t.scale;
          return { scale: newScale, x: mx - (mx - t.x) * ratio, y: my - (my - t.y) * ratio };
        });
      } else {
        // Pan
        setTransform(t => ({ ...t, x: t.x - e.deltaX, y: t.y - e.deltaY }));
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        isDragging.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        el.style.cursor = 'grabbing';
      }
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const dx = e.clientX - lastMouse.current.x;
      const dy = e.clientY - lastMouse.current.y;
      lastMouse.current = { x: e.clientX, y: e.clientY };
      setTransform(t => ({ ...t, x: t.x + dx, y: t.y + dy }));
    };
    const onMouseUp = () => { isDragging.current = false; el.style.cursor = 'grab'; };

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

  const resetView = useCallback(() => setTransform({ x: 0, y: 0, scale: 1 }), []);
  const zoomIn = useCallback(() => setTransform(t => ({ ...t, scale: Math.min(4, t.scale * 1.3) })), []);
  const zoomOut = useCallback(() => setTransform(t => ({ ...t, scale: Math.max(0.1, t.scale / 1.3) })), []);

  return { containerRef, transform, resetView, zoomIn, zoomOut };
}

// ── Sparkline ────────────────────────────────────────────────────────

function Sparkline({ data, activeIdx, width = 280, height = 40 }: { data: number[]; activeIdx?: number; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const max = Math.max(...data, 1);
  const stepX = width / (data.length - 1);
  const points = data.map((v, i) => `${i * stepX},${height - (v / max) * (height - 4)}`).join(' ');
  const areaPoints = `0,${height} ${points} ${(data.length - 1) * stepX},${height}`;
  return (
    <svg className={styles.sparklineSvg} width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polygon points={areaPoints} fill="rgba(3, 102, 214, 0.08)" />
      <polyline points={points} fill="none" stroke="var(--blue)" strokeWidth="1.5" />
      {data.map((v, i) => (
        <circle key={i} cx={i * stepX} cy={height - (v / max) * (height - 4)} r={i === activeIdx ? 4 : 2.5}
          fill={v === 0 ? COLOR_GREEN : i === activeIdx ? '#0366d6' : 'var(--blue)'} stroke={i === activeIdx ? 'white' : 'none'} strokeWidth={i === activeIdx ? 1.5 : 0} />
      ))}
    </svg>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function ProofGraph() {
  const { data: declData, isLoading: declLoading } = useProofGraphDeclarations();
  const { data: timelineData } = useProofGraphTimeline();
  const [selectedNodeId, setSelectedNodeId] = useState('');
  const [selectedTimelineIdx, setSelectedTimelineIdx] = useState(-1); // -1 = current state
  const [codeExpanded, setCodeExpanded] = useState(true);
  const { containerRef, transform, resetView, zoomIn, zoomOut } = useZoomPan();

  // When a timeline point is selected, fetch snapshot declarations
  const selectedIteration = selectedTimelineIdx >= 0 && timelineData ? timelineData[selectedTimelineIdx]?.iteration : '';
  const { data: snapshotData } = useProofGraphSnapshot(selectedIteration);

  // Determine which data to display: snapshot or current
  const activeData: DeclarationsResponse | undefined = selectedIteration && snapshotData ? snapshotData : declData;

  // Compute which files were touched in previous iteration (for orange vs red)
  const touchedInPrevIter = useMemo(() => {
    const set = new Set<string>();
    if (!timelineData || timelineData.length === 0) return set;

    // Determine the "previous" iteration relative to the viewed one
    let viewIdx = selectedTimelineIdx >= 0 ? selectedTimelineIdx : timelineData.length - 1;
    const prevIdx = viewIdx - 1;
    if (prevIdx < 0 || viewIdx <= 0) {
      // At iteration 0 or current with only 1 iter: nothing was "touched previously"
      // For current view, check the last timeline iteration
      if (selectedTimelineIdx < 0 && timelineData.length >= 1) {
        const lastPoint = timelineData[timelineData.length - 1];
        // Files that have entries in this last iteration's perFile are "touched"
        for (const f of Object.keys(lastPoint.perFile)) set.add(f);
        for (const k of Object.keys(lastPoint.perDeclaration)) set.add(k);
      }
      return set;
    }

    // Files/declarations that exist in the current point's perDeclaration
    // were worked on in this iteration
    const currentPoint = timelineData[viewIdx];
    if (currentPoint) {
      for (const f of Object.keys(currentPoint.perFile)) set.add(f);
      for (const k of Object.keys(currentPoint.perDeclaration)) set.add(k);
    }
    return set;
  }, [timelineData, selectedTimelineIdx]);

  // Selected node detail
  const selectedFile = selectedNodeId.split('::')[0] || '';
  const selectedName = selectedNodeId.split('::')[1] || '';
  const { data: nodeDetail } = useProofGraphNodeDetail(selectedFile, selectedName);

  // Layout
  const layout = useMemo(() => {
    if (!activeData) return null;
    return computeRadialLayout(activeData.declarations, activeData.edges, activeData.files, touchedInPrevIter);
  }, [activeData, touchedInPrevIter]);

  // Stuck summary
  const stuckSummary = useMemo(() => {
    if (!layout) return null;
    let solved = 0, orange = 0, red = 0;
    for (const n of layout.nodes) {
      if (!n.decl.hasSorry) solved++;
      else if (n.touchedPrev) orange++;
      else red++;
    }
    return { solved, orange, red, total: layout.nodes.length };
  }, [layout]);

  // Blocked count
  const blockedCount = useMemo(() => {
    if (!layout) return 0;
    const s = new Set<string>();
    for (const e of layout.edges) { if (e.isBlocked && e.from.decl.hasSorry) s.add(e.from.id); }
    return s.size;
  }, [layout]);

  // Highlight edges connected to selected node
  const highlightEdges = useMemo(() => {
    if (!layout || !selectedNodeId) return new Set<string>();
    const s = new Set<string>();
    for (const e of layout.edges) {
      if (e.from.id === selectedNodeId || e.to.id === selectedNodeId) s.add(`${e.from.id}->${e.to.id}`);
    }
    return s;
  }, [layout, selectedNodeId]);

  // Per-node sparkline from timeline
  const nodeSparkline = useMemo(() => {
    if (!timelineData || !selectedNodeId) return null;
    const data: number[] = [];
    for (const point of timelineData) {
      const entry = point.perDeclaration[selectedNodeId];
      if (entry) data.push(entry.sorryCount);
      else {
        // Try file-level match
        const file = selectedNodeId.split('::')[0];
        let found = false;
        for (const [k, v] of Object.entries(point.perDeclaration)) {
          if (k.startsWith(file + '::') && k.split('::')[1] === selectedNodeId.split('::')[1]) {
            data.push(v.sorryCount); found = true; break;
          }
        }
        if (!found) data.push(0);
      }
    }
    return data.length > 1 ? data : null;
  }, [timelineData, selectedNodeId]);

  // Timeline
  const timelineMax = useMemo(() => {
    if (!timelineData) return 1;
    return Math.max(...timelineData.map(t => t.totalSorry), 1);
  }, [timelineData]);

  // Code lines
  const codeLines = useMemo(() => nodeDetail?.declaration?.body?.split('\n') ?? [], [nodeDetail]);
  const highlightedCodeLines = useMemo(() => highlightLeanLines(codeLines), [codeLines]);

  const handleNodeClick = useCallback((id: string) => {
    setSelectedNodeId(prev => prev === id ? '' : id);
    setCodeExpanded(true);
  }, []);

  const handleTimelineClick = useCallback((idx: number) => {
    setSelectedTimelineIdx(prev => prev === idx ? -1 : idx);
  }, []);

  if (declLoading) return <div className={styles.loading}>Loading proof graph…</div>;
  if (!declData || declData.declarations.length === 0) {
    return <div className={styles.page}><div className={styles.empty}><h3>No declarations found</h3><p>No .lean files with theorem/lemma declarations found in the project</p></div></div>;
  }
  if (!layout) return null;

  const isSnapshotView = selectedTimelineIdx >= 0;
  const viewLabel = isSnapshotView && timelineData ? timelineData[selectedTimelineIdx].iteration.replace('iter-', 'Iteration #') : 'Current state';

  return (
    <div className={styles.page}>
      {/* ── Stuck detector + view label ── */}
      <div className={styles.stuckBanner}>
        {isSnapshotView && <span className={styles.viewLabel}>Viewing: {viewLabel}</span>}
        {!isSnapshotView && <span className={styles.viewLabel}>Current state</span>}
        {stuckSummary && (
          <>
            {stuckSummary.red > 0 && (
              <span className={`${styles.stuckChip} ${styles.stuckChipRed}`}><span className={styles.stuckDot} style={{ background: COLOR_RED }} />{stuckSummary.red} stuck</span>
            )}
            {blockedCount > 0 && (
              <span className={`${styles.stuckChip} ${styles.stuckChipAmber}`}><span className={styles.stuckDot} style={{ background: COLOR_ORANGE }} />{blockedCount} blocked by deps</span>
            )}
            {stuckSummary.orange > 0 && (
              <span className={`${styles.stuckChip} ${styles.stuckChipOrange}`}><span className={styles.stuckDot} style={{ background: COLOR_ORANGE }} />{stuckSummary.orange} in progress</span>
            )}
            {stuckSummary.solved > 0 && (
              <span className={`${styles.stuckChip} ${styles.stuckChipGreen}`}><span className={styles.stuckDot} style={{ background: COLOR_GREEN }} />{stuckSummary.solved} solved</span>
            )}
          </>
        )}
        <div className={styles.zoomControls}>
          <button className={styles.zoomBtn} onClick={zoomOut} title="Zoom out">−</button>
          <button className={styles.zoomBtn} onClick={resetView} title="Reset view">⟲</button>
          <button className={styles.zoomBtn} onClick={zoomIn} title="Zoom in">+</button>
        </div>
      </div>

      {/* ── Legend ── */}
      <div className={styles.legend}>
        <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: COLOR_GREEN }} /> Solved</span>
        <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: COLOR_ORANGE }} /> Sorry (touched prev iter)</span>
        <span className={styles.legendItem}><span className={styles.legendDot} style={{ background: COLOR_RED }} /> Sorry (not touched / stale)</span>
        <span className={styles.legendItem}><svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke={COLOR_RED} strokeDasharray="3 2" strokeWidth="1.5" /></svg> Blocked dep</span>
      </div>

      {/* ── Main area ── */}
      <div className={styles.mainArea}>
        {/* Graph with zoom/pan */}
        <div className={styles.graphContainer} ref={containerRef} style={{ cursor: 'grab' }}>
          <svg
            className={styles.graphSvg}
            width={layout.width}
            height={layout.height}
            style={{ transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`, transformOrigin: '0 0' }}
          >
            <defs>
              <marker id="arrow" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" fill="var(--border)" /></marker>
              <marker id="arrow-blocked" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto"><polygon points="0 0, 6 2, 0 4" fill={COLOR_RED} /></marker>
            </defs>

            {/* File group backgrounds */}
            {layout.groups.map((g) => (
              <g key={g.file}>
                <rect x={g.x} y={g.y} width={g.w} height={g.h} rx={8} ry={8} fill={FILE_FILLS[g.colorIdx]} stroke={FILE_STROKES[g.colorIdx]} strokeWidth={1.5} />
                <text x={g.x + 10} y={g.y + 16} className={styles.fileGroupLabel}>{g.file}</text>
              </g>
            ))}

            {/* Edges */}
            {layout.edges.map((e, i) => {
              const key = `${e.from.id}->${e.to.id}`;
              const isHl = highlightEdges.has(key);
              const fx = e.from.x + e.from.w / 2, fy = e.from.y + e.from.h / 2;
              const tx = e.to.x + e.to.w / 2, ty = e.to.y + e.to.h / 2;
              const mx = (fx + tx) / 2, my = (fy + ty) / 2;
              // Slight curve
              const dx = tx - fx, dy = ty - fy;
              const cx = mx - dy * 0.15, cy = my + dx * 0.15;
              const path = `M${fx},${fy} Q${cx},${cy} ${tx},${ty}`;
              return (
                <path key={i} d={path} fill="none"
                  stroke={isHl ? 'var(--blue)' : e.isBlocked ? COLOR_RED : 'var(--border)'}
                  strokeWidth={isHl ? 2 : 1.2}
                  strokeDasharray={e.isBlocked && !isHl ? '4 3' : 'none'}
                  opacity={isHl ? 0.9 : e.isBlocked ? 0.6 : 0.35}
                  markerEnd={e.isBlocked ? 'url(#arrow-blocked)' : 'url(#arrow)'}
                />
              );
            })}

            {/* Nodes */}
            {layout.nodes.map(n => {
              const isSel = n.id === selectedNodeId;
              const attempts = n.decl.totalAttempts ?? 0;
              const msStatus = n.decl.latestMilestoneStatus;
              return (
                <g key={n.id} className={`${styles.node} ${isSel ? styles.nodeSelected : ''}`} onClick={() => handleNodeClick(n.id)}>
                  {/* Attempt ring for high-attempt nodes */}
                  {attempts > 3 && (
                    <rect x={n.x - 3} y={n.y - 3} width={n.w + 6} height={n.h + 6} rx={9} ry={9}
                      fill="none" stroke={n.color} strokeWidth={2} opacity={0.35} />
                  )}
                  {/* Main rect */}
                  <rect className={styles.nodeRect} x={n.x} y={n.y} width={n.w} height={n.h}
                    fill="var(--bg-primary)" stroke={isSel ? 'var(--blue)' : n.color} strokeWidth={isSel ? 2.5 : 1.5} />
                  {/* Kind + name */}
                  <text x={n.x + 6} y={n.y + 13} fontSize="9" fontWeight="700" fill={n.color} textTransform="uppercase" fontFamily="var(--font-sans)">{n.decl.kind}</text>
                  <text x={n.x + 6} y={n.y + 27} fontSize="11" fontWeight="500" fill="var(--text-primary)" fontFamily="var(--font-mono)">
                    {n.decl.name.length > 20 ? n.decl.name.slice(0, 19) + '…' : n.decl.name}
                  </text>
                  {/* Bottom row: attempts + status badges */}
                  {(attempts > 0 || msStatus) && (
                    <text x={n.x + 6} y={n.y + 39} fontSize="9" fill="var(--text-muted)" fontFamily="var(--font-mono)">
                      {attempts > 0 ? `${attempts} att` : ''}{attempts > 0 && msStatus ? ' · ' : ''}{msStatus || ''}
                    </text>
                  )}
                  {/* Sorry badge */}
                  {n.decl.hasSorry && (
                    <>
                      <rect x={n.x + n.w - 30} y={n.y + 4} width={24} height={14} rx={7} ry={7} fill={n.color} opacity={0.15} />
                      <text x={n.x + n.w - 18} y={n.y + 14} fontSize="9" fontWeight="700" fill={n.color} textAnchor="middle" fontFamily="var(--font-mono)">{n.decl.sorryCount}s</text>
                    </>
                  )}
                  {!n.decl.hasSorry && (
                    <text x={n.x + n.w - 16} y={n.y + 14} fill={COLOR_GREEN} fontSize="11" fontWeight="700">✓</text>
                  )}
                  {/* Blocker indicator */}
                  {n.decl.blocker && (
                    <text x={n.x + n.w - 16} y={n.y + 38} fontSize="10" fill={COLOR_RED} title={n.decl.blocker}>⚠</text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* ── Detail sidebar ── */}
        <div className={styles.detailSidebar}>
          {!selectedNodeId ? (
            <div className={styles.detailEmpty}>Click a node to see code, milestone history, and proof attempts</div>
          ) : (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailName}>{selectedName}</div>
                <div className={styles.detailFile}>{selectedFile}:{nodeDetail?.declaration?.line ?? '?'}</div>
                <div className={styles.detailMeta}>
                  {nodeDetail?.declaration && (
                    <span className={styles.detailBadge} style={{ color: nodeDetail.declaration.hasSorry ? COLOR_RED : COLOR_GREEN, borderColor: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.3)' : 'rgba(40,167,69,0.3)', background: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.06)' : 'rgba(40,167,69,0.06)' }}>
                      {nodeDetail.declaration.hasSorry ? `${nodeDetail.declaration.sorryCount} sorry` : 'solved'}
                    </span>
                  )}
                  {nodeDetail?.declaration && (
                    <span className={styles.detailBadge} style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}>{nodeDetail.declaration.kind}</span>
                  )}
                  {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && (
                    <span className={styles.detailBadge} style={{ color: 'var(--blue)', borderColor: 'rgba(3,102,214,0.3)', background: 'rgba(3,102,214,0.06)' }}>
                      {nodeDetail.milestones.length} session{nodeDetail.milestones.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Per-node sparkline */}
              {nodeSparkline && (
                <div className={styles.sparklineSection}>
                  <div className={styles.sparklineLabel}>Sorry count across iterations</div>
                  <Sparkline data={nodeSparkline} activeIdx={selectedTimelineIdx >= 0 ? selectedTimelineIdx : undefined} />
                </div>
              )}

              {/* Code — NEVER truncated */}
              <div className={styles.codeSection}>
                <div className={styles.codeSectionHeader} onClick={() => setCodeExpanded(!codeExpanded)}>
                  {codeExpanded ? '▾' : '▸'} Code {codeLines.length > 0 ? `(${codeLines.length} lines)` : ''}
                </div>
                {codeExpanded && codeLines.length > 0 && (
                  <div className={styles.codeBlock}>
                    {codeLines.map((line, i) => (
                      <div key={i}><LeanCodeLine text={line} tokens={highlightedCodeLines[i]} /></div>
                    ))}
                  </div>
                )}
              </div>

              {/* Milestones with attempts (journal-style) */}
              {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && (
                <div className={styles.milestonesSection}>
                  <div className={styles.milestonesSectionLabel}>Milestone history</div>
                  {nodeDetail.milestones.map((m, i) => (
                    <div key={i} className={styles.milestoneEntry} style={{ borderLeftColor: STATUS_COLORS[m.status] || 'var(--border)' }}>
                      <div className={styles.milestoneEntryHeader}>
                        <span className={styles.milestoneSession}>{m.sessionId.replace('session_', '#')}</span>
                        <span className={styles.milestoneStatus} style={{ color: STATUS_COLORS[m.status] || 'var(--text-muted)' }}>{m.status}</span>
                      </div>
                      {m.blocker && <div className={styles.milestoneBlocker}>Blocker: {m.blocker}</div>}
                      {m.nextSteps && <div className={styles.milestoneNext}>Next: {m.nextSteps}</div>}
                      {m.keyLemmas && m.keyLemmas.length > 0 && <div className={styles.milestoneLemmas}>Lemmas: {m.keyLemmas.join(', ')}</div>}
                      {Array.isArray(m.attempts) && m.attempts.length > 0 && (
                        <div className={styles.milestoneAttempts}>
                          {(m.attempts as any[]).map((att, ai) => <AttemptCard key={ai} att={att} />)}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>

      {/* ── Timeline (only iterations with snapshots) ── */}
      {timelineData && timelineData.length > 0 && (
        <div className={styles.timeline}>
          <div className={styles.timelineHeader}>
            <span className={styles.timelineTitle}>Sorry count per iteration (click to view state)</span>
            {isSnapshotView && (
              <button className={styles.timelineResetBtn} onClick={() => setSelectedTimelineIdx(-1)}>← Back to current</button>
            )}
          </div>
          <div className={styles.timelineChart}>
            {timelineData.map((point, i) => {
              const heightPct = (point.totalSorry / timelineMax) * 100;
              const isActive = i === selectedTimelineIdx;
              const barColor = point.totalSorry === 0 ? COLOR_GREEN : COLOR_ORANGE;
              return (
                <div key={i}
                  className={`${styles.timelineBar} ${isActive ? styles.timelineBarActive : ''}`}
                  style={{ height: `${Math.max(heightPct, 4)}%`, background: barColor, opacity: isActive ? 1 : 0.55 }}
                  onClick={() => handleTimelineClick(i)}
                  title={`${point.iteration}: ${point.totalSorry} sorry — click to view`}
                >
                  <span className={styles.timelineBarLabel}>{point.totalSorry}</span>
                </div>
              );
            })}
          </div>
          <div className={styles.timelineLabels}>
            {timelineData.map((point, i) => (
              <div key={i} className={`${styles.timelineIterLabel} ${i === selectedTimelineIdx ? styles.timelineIterLabelActive : ''}`}>
                {point.iteration.replace('iter-', '#')}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}