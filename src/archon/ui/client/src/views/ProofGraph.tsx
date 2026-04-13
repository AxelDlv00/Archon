/**
 * ProofGraph — Proof evolution visualization
 *
 * Layout:
 *   Top:     Stuck detector summary bar
 *   Middle:  SVG dependency graph (left) + detail sidebar (right)
 *   Bottom:  Sorry timeline bar chart across iterations
 */
import { useState, useMemo, useCallback, useEffect } from 'react';
import {
  useProofGraphDeclarations,
  useProofGraphTimeline,
  useProofGraphNodeDetail,
  type GraphDeclaration,
  type GraphEdge,
  type TimelinePoint,
} from '../hooks/useProofGraph';
import { STATUS_COLORS } from '../utils/constants';
import AttemptCard from '../components/AttemptCard';
import LeanCodeLine from '../components/LeanCodeLine';
import { highlightLeanLines } from '../utils/leanHighlight';
import styles from './ProofGraph.module.css';

// ── Color helpers ────────────────────────────────────────────────────

function nodeColor(decl: GraphDeclaration, attemptCount: number, iterationsSinceProgress: number): string {
  if (!decl.hasSorry) return '#28a745';               // solved (green)
  if (iterationsSinceProgress >= 3) return '#cb2431';  // stalled (red)
  if (attemptCount > 0) return '#e36209';              // in progress (amber)
  return '#959da5';                                     // untouched (gray)
}

function nodeColorLabel(decl: GraphDeclaration, attemptCount: number, iterationsSinceProgress: number): string {
  if (!decl.hasSorry) return 'Solved';
  if (iterationsSinceProgress >= 3) return 'Stalled';
  if (attemptCount > 0) return 'In progress';
  return 'Untouched';
}

// ── Graph layout (simple force-directed-like placement) ──────────────

interface LayoutNode {
  id: string;
  decl: GraphDeclaration;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  attemptCount: number;
  iterationsSinceProgress: number;
}

interface LayoutFileGroup {
  file: string;
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
}

interface LayoutEdge {
  from: LayoutNode;
  to: LayoutNode;
  isBlocked: boolean;
}

const NODE_W = 180;
const NODE_H = 36;
const NODE_GAP_X = 24;
const NODE_GAP_Y = 14;
const GROUP_PAD = 16;
const GROUP_HEADER = 24;
const GROUP_GAP = 32;

const FILE_COLORS = [
  'rgba(3, 102, 214, 0.06)',
  'rgba(111, 66, 193, 0.06)',
  'rgba(227, 98, 9, 0.06)',
  'rgba(40, 167, 69, 0.06)',
  'rgba(203, 36, 49, 0.06)',
  'rgba(0, 134, 114, 0.06)',
];

const FILE_BORDER_COLORS = [
  'rgba(3, 102, 214, 0.2)',
  'rgba(111, 66, 193, 0.2)',
  'rgba(227, 98, 9, 0.2)',
  'rgba(40, 167, 69, 0.2)',
  'rgba(203, 36, 49, 0.2)',
  'rgba(0, 134, 114, 0.2)',
];

function computeLayout(
  declarations: GraphDeclaration[],
  edges: GraphEdge[],
  files: { file: string; declarations: string[] }[],
  milestoneAttemptCounts: Map<string, number>,
  milestoneStalledIterations: Map<string, number>,
): { nodes: LayoutNode[]; groups: LayoutFileGroup[]; edges: LayoutEdge[]; width: number; height: number } {
  const nodeMap = new Map<string, LayoutNode>();
  const groups: LayoutFileGroup[] = [];
  let globalX = GROUP_GAP;
  let maxHeight = 0;

  // Lay out file groups left-to-right, declarations stacked vertically inside each
  for (let fi = 0; fi < files.length; fi++) {
    const fg = files[fi];
    const fileDecls = declarations.filter(d => d.file === fg.file);
    if (fileDecls.length === 0) continue;

    // How many columns? 1 column if <=8 decls, 2 if more
    const cols = fileDecls.length > 8 ? 2 : 1;
    const perCol = Math.ceil(fileDecls.length / cols);

    let groupW = cols * NODE_W + (cols - 1) * NODE_GAP_X + GROUP_PAD * 2;
    let groupH = GROUP_HEADER + perCol * (NODE_H + NODE_GAP_Y) + GROUP_PAD;

    const groupX = globalX;
    const groupY = GROUP_GAP;
    const colorIdx = fi % FILE_COLORS.length;

    for (let di = 0; di < fileDecls.length; di++) {
      const d = fileDecls[di];
      const col = Math.floor(di / perCol);
      const row = di % perCol;
      const x = groupX + GROUP_PAD + col * (NODE_W + NODE_GAP_X);
      const y = groupY + GROUP_HEADER + row * (NODE_H + NODE_GAP_Y);
      const attemptCount = milestoneAttemptCounts.get(d.id) ?? 0;
      const itersSinceProgress = milestoneStalledIterations.get(d.id) ?? 0;
      const color = nodeColor(d, attemptCount, itersSinceProgress);

      const node: LayoutNode = { id: d.id, decl: d, x, y, w: NODE_W, h: NODE_H, color, attemptCount, iterationsSinceProgress: itersSinceProgress };
      nodeMap.set(d.id, node);
    }

    groups.push({
      file: fg.file,
      x: groupX,
      y: groupY,
      w: groupW,
      h: groupH,
      color: FILE_COLORS[colorIdx],
    });

    globalX += groupW + GROUP_GAP;
    maxHeight = Math.max(maxHeight, groupY + groupH);
  }

  // Build layout edges
  const layoutEdges: LayoutEdge[] = [];
  for (const e of edges) {
    const from = nodeMap.get(e.from);
    const to = nodeMap.get(e.to);
    if (from && to) {
      // Edge is "blocked" if `from` depends on `to` and `to` still has sorry
      const isBlocked = to.decl.hasSorry;
      layoutEdges.push({ from, to, isBlocked });
    }
  }

  return {
    nodes: Array.from(nodeMap.values()),
    groups,
    edges: layoutEdges,
    width: globalX + GROUP_GAP,
    height: maxHeight + GROUP_GAP + 20,
  };
}

// ── Stuck detector ───────────────────────────────────────────────────

interface StuckSummary {
  stalled: number;
  blocked: number;
  inProgress: number;
  solved: number;
  untouched: number;
}

function computeStuckSummary(nodes: LayoutNode[]): StuckSummary {
  let stalled = 0, blocked = 0, inProgress = 0, solved = 0, untouched = 0;
  for (const n of nodes) {
    if (!n.decl.hasSorry) { solved++; continue; }
    if (n.iterationsSinceProgress >= 3) { stalled++; continue; }
    if (n.attemptCount > 0) { inProgress++; continue; }
    untouched++;
  }
  // blocked = nodes that depend on unsolved nodes (approximate from edges)
  return { stalled, blocked, inProgress, solved, untouched };
}

// ── Sparkline component ──────────────────────────────────────────────

function Sparkline({ data, width = 280, height = 40 }: { data: number[]; width?: number; height?: number }) {
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
        <circle key={i} cx={i * stepX} cy={height - (v / max) * (height - 4)} r="2.5"
          fill={v === 0 ? 'var(--green)' : 'var(--blue)'} />
      ))}
    </svg>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function ProofGraph() {
  const { data: declData, isLoading: declLoading } = useProofGraphDeclarations();
  const { data: timelineData } = useProofGraphTimeline();
  const [selectedNodeId, setSelectedNodeId] = useState<string>('');
  const [selectedTimelineIdx, setSelectedTimelineIdx] = useState<number>(-1);
  const [codeExpanded, setCodeExpanded] = useState(true);

  // Parse selected node
  const selectedFile = selectedNodeId.split('::')[0] || '';
  const selectedName = selectedNodeId.split('::')[1] || '';
  const { data: nodeDetail } = useProofGraphNodeDetail(selectedFile, selectedName);

  // Build attempt count map from milestone data (approximate from journal API)
  // For now, we use a simple heuristic: declarations with sorry that have been
  // worked on across iterations get attempt counts
  const milestoneAttemptCounts = useMemo(() => {
    const map = new Map<string, number>();
    // We'll enhance this when we have cross-session data
    return map;
  }, []);

  const milestoneStalledIterations = useMemo(() => {
    const map = new Map<string, number>();
    return map;
  }, []);

  // Compute graph layout
  const layout = useMemo(() => {
    if (!declData) return null;
    return computeLayout(
      declData.declarations,
      declData.edges,
      declData.files,
      milestoneAttemptCounts,
      milestoneStalledIterations,
    );
  }, [declData, milestoneAttemptCounts, milestoneStalledIterations]);

  // Stuck summary
  const stuckSummary = useMemo(() => {
    if (!layout) return null;
    return computeStuckSummary(layout.nodes);
  }, [layout]);

  // Blocked edge count (nodes whose dependencies have sorry)
  const blockedCount = useMemo(() => {
    if (!layout) return 0;
    const blockedNodes = new Set<string>();
    for (const e of layout.edges) {
      if (e.isBlocked && e.from.decl.hasSorry) {
        blockedNodes.add(e.from.id);
      }
    }
    return blockedNodes.size;
  }, [layout]);

  // Edges connected to selected node (for highlighting)
  const highlightEdges = useMemo(() => {
    if (!layout || !selectedNodeId) return new Set<string>();
    const set = new Set<string>();
    for (const e of layout.edges) {
      if (e.from.id === selectedNodeId || e.to.id === selectedNodeId) {
        set.add(`${e.from.id}->${e.to.id}`);
      }
    }
    return set;
  }, [layout, selectedNodeId]);

  // Per-node sorry sparkline data from timeline
  const nodeSparkline = useMemo(() => {
    if (!timelineData || !selectedNodeId) return null;
    const file = selectedNodeId.split('::')[0];
    // Extract the file's sorry count across iterations
    const data: number[] = [];
    for (const point of timelineData) {
      // Find matching file key
      let count = 0;
      for (const [key, val] of Object.entries(point.perFile)) {
        if (key === file || key.endsWith('/' + file) || file.endsWith(key)) {
          count = val;
          break;
        }
      }
      data.push(count);
    }
    return data.length > 1 ? data : null;
  }, [timelineData, selectedNodeId]);

  // Timeline bar chart
  const timelineMax = useMemo(() => {
    if (!timelineData) return 1;
    return Math.max(...timelineData.map(t => t.totalSorry), 1);
  }, [timelineData]);

  // Highlighted lines in code
  const codeLines = useMemo(() => {
    if (!nodeDetail?.declaration?.body) return [];
    return nodeDetail.declaration.body.split('\n');
  }, [nodeDetail]);

  const highlightedCodeLines = useMemo(() => highlightLeanLines(codeLines), [codeLines]);

  const handleNodeClick = useCallback((id: string) => {
    setSelectedNodeId(prev => prev === id ? '' : id);
    setCodeExpanded(true);
  }, []);

  if (declLoading) {
    return <div className={styles.loading}>Loading proof graph…</div>;
  }

  if (!declData || declData.declarations.length === 0) {
    return (
      <div className={styles.page}>
        <div className={styles.empty}>
          <h3>No declarations found</h3>
          <p>No .lean files with theorem/lemma declarations found in the project</p>
        </div>
      </div>
    );
  }

  if (!layout) return null;

  return (
    <div className={styles.page}>
      {/* ── Stuck detector banner ── */}
      {stuckSummary && (
        <div className={styles.stuckBanner}>
          {stuckSummary.stalled > 0 && (
            <span className={`${styles.stuckChip} ${styles.stuckChipRed}`}>
              <span className={styles.stuckDot} style={{ background: '#cb2431' }} />
              {stuckSummary.stalled} stalled
            </span>
          )}
          {blockedCount > 0 && (
            <span className={`${styles.stuckChip} ${styles.stuckChipAmber}`}>
              <span className={styles.stuckDot} style={{ background: '#e36209' }} />
              {blockedCount} blocked by deps
            </span>
          )}
          {stuckSummary.inProgress > 0 && (
            <span className={`${styles.stuckChip} ${styles.stuckChipBlue}`}>
              <span className={styles.stuckDot} style={{ background: '#0366d6' }} />
              {stuckSummary.inProgress} in progress
            </span>
          )}
          {stuckSummary.solved > 0 && (
            <span className={`${styles.stuckChip} ${styles.stuckChipGreen}`}>
              <span className={styles.stuckDot} style={{ background: '#28a745' }} />
              {stuckSummary.solved} solved
            </span>
          )}
          {stuckSummary.untouched > 0 && (
            <span className={`${styles.stuckChip} ${styles.stuckChipGray}`}>
              <span className={styles.stuckDot} style={{ background: '#959da5' }} />
              {stuckSummary.untouched} untouched
            </span>
          )}
        </div>
      )}

      {/* ── Legend ── */}
      <div className={styles.legend}>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#28a745' }} /> Solved
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#0366d6' }} /> In progress
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#e36209' }} /> Stalled
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#cb2431' }} /> Stalled 3+ iters
        </span>
        <span className={styles.legendItem}>
          <span className={styles.legendDot} style={{ background: '#959da5' }} /> Untouched
        </span>
        <span className={styles.legendItem}>
          <svg width="20" height="8"><line x1="0" y1="4" x2="20" y2="4" stroke="#cb2431" strokeDasharray="3 2" strokeWidth="1.5" /></svg>
          Blocked dep
        </span>
      </div>

      {/* ── Main area: graph + detail ── */}
      <div className={styles.mainArea}>
        <div className={styles.graphContainer}>
          <svg
            className={styles.graphSvg}
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            <defs>
              <marker id="arrow" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                <polygon points="0 0, 6 2, 0 4" className={styles.edgeArrow} />
              </marker>
              <marker id="arrow-blocked" markerWidth="6" markerHeight="4" refX="6" refY="2" orient="auto">
                <polygon points="0 0, 6 2, 0 4" className={styles.edgeArrowBlocked} />
              </marker>
            </defs>

            {/* File group backgrounds */}
            {layout.groups.map((g, i) => (
              <g key={g.file} className={styles.fileGroup}>
                <rect
                  className={styles.fileGroupRect}
                  x={g.x} y={g.y} width={g.w} height={g.h}
                  fill={g.color}
                  stroke={FILE_BORDER_COLORS[i % FILE_BORDER_COLORS.length]}
                />
                <text
                  className={styles.fileGroupLabel}
                  x={g.x + 10} y={g.y + 16}
                >
                  {g.file}
                </text>
              </g>
            ))}

            {/* Edges */}
            {layout.edges.map((e, i) => {
              const key = `${e.from.id}->${e.to.id}`;
              const isHighlighted = highlightEdges.has(key);
              const x1 = e.from.x + e.from.w;
              const y1 = e.from.y + e.from.h / 2;
              const x2 = e.to.x;
              const y2 = e.to.y + e.to.h / 2;
              // Simple curved path
              const midX = (x1 + x2) / 2;
              const path = `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`;

              return (
                <path
                  key={i}
                  d={path}
                  className={`${styles.edge} ${
                    isHighlighted ? styles.edgeHighlight :
                    e.isBlocked ? styles.edgeBlocked :
                    styles.edgeNormal
                  }`}
                  markerEnd={e.isBlocked ? 'url(#arrow-blocked)' : 'url(#arrow)'}
                />
              );
            })}

            {/* Nodes */}
            {layout.nodes.map(n => {
              const isSelected = n.id === selectedNodeId;
              return (
                <g
                  key={n.id}
                  className={`${styles.node} ${isSelected ? styles.nodeSelected : ''}`}
                  onClick={() => handleNodeClick(n.id)}
                >
                  {/* Attempt count ring */}
                  {n.attemptCount > 2 && (
                    <rect
                      className={styles.nodeAttemptRing}
                      x={n.x - 3} y={n.y - 3}
                      width={n.w + 6} height={n.h + 6}
                      rx={9} ry={9}
                      stroke={n.color}
                    />
                  )}

                  {/* Main rect */}
                  <rect
                    className={styles.nodeRect}
                    x={n.x} y={n.y}
                    width={n.w} height={n.h}
                    fill="var(--bg-primary)"
                    stroke={n.color}
                  />

                  {/* Kind badge */}
                  <text
                    className={styles.nodeKindBadge}
                    x={n.x + 6} y={n.y + 12}
                    fill={n.color}
                  >
                    {n.decl.kind}
                  </text>

                  {/* Name */}
                  <text
                    className={styles.nodeLabel}
                    x={n.x + 6} y={n.y + 26}
                    fill="var(--text-primary)"
                  >
                    {n.decl.name.length > 18 ? n.decl.name.slice(0, 17) + '…' : n.decl.name}
                  </text>

                  {/* Sorry count badge */}
                  {n.decl.hasSorry && (
                    <>
                      <rect
                        x={n.x + n.w - 28} y={n.y + 4}
                        width={22} height={14}
                        rx={7} ry={7}
                        fill={n.color}
                        opacity={0.15}
                      />
                      <text
                        className={styles.nodeSorryBadge}
                        x={n.x + n.w - 17} y={n.y + 14}
                        fill={n.color}
                        textAnchor="middle"
                      >
                        {n.decl.sorryCount}s
                      </text>
                    </>
                  )}

                  {/* Solved checkmark */}
                  {!n.decl.hasSorry && (
                    <text
                      x={n.x + n.w - 16} y={n.y + 14}
                      fill="#28a745"
                      fontSize="11"
                      fontWeight="700"
                    >
                      ✓
                    </text>
                  )}
                </g>
              );
            })}
          </svg>
        </div>

        {/* ── Detail sidebar ── */}
        <div className={styles.detailSidebar}>
          {!selectedNodeId ? (
            <div className={styles.detailEmpty}>
              Click a node to see declaration details, code, and milestone history
            </div>
          ) : (
            <>
              <div className={styles.detailHeader}>
                <div className={styles.detailName}>{selectedName}</div>
                <div className={styles.detailFile}>{selectedFile}:{nodeDetail?.declaration?.line ?? '?'}</div>
                <div className={styles.detailMeta}>
                  {nodeDetail?.declaration && (
                    <span
                      className={styles.detailBadge}
                      style={{
                        color: nodeDetail.declaration.hasSorry ? '#cb2431' : '#28a745',
                        borderColor: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.3)' : 'rgba(40,167,69,0.3)',
                        background: nodeDetail.declaration.hasSorry ? 'rgba(203,36,49,0.06)' : 'rgba(40,167,69,0.06)',
                      }}
                    >
                      {nodeDetail.declaration.hasSorry
                        ? `${nodeDetail.declaration.sorryCount} sorry`
                        : 'solved'}
                    </span>
                  )}
                  {nodeDetail?.declaration && (
                    <span
                      className={styles.detailBadge}
                      style={{ color: 'var(--text-muted)', borderColor: 'var(--border)', background: 'var(--bg-tertiary)' }}
                    >
                      {nodeDetail.declaration.kind}
                    </span>
                  )}
                  {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && (
                    <span
                      className={styles.detailBadge}
                      style={{ color: 'var(--blue)', borderColor: 'rgba(3,102,214,0.3)', background: 'rgba(3,102,214,0.06)' }}
                    >
                      {nodeDetail.milestones.length} session{nodeDetail.milestones.length > 1 ? 's' : ''}
                    </span>
                  )}
                </div>
              </div>

              {/* Per-node sparkline */}
              {nodeSparkline && (
                <div className={styles.sparklineSection}>
                  <div className={styles.sparklineLabel}>Sorry count over iterations (file)</div>
                  <Sparkline data={nodeSparkline} />
                </div>
              )}

              {/* Code */}
              <div className={styles.codeSection}>
                <div className={styles.codeSectionHeader} onClick={() => setCodeExpanded(!codeExpanded)}>
                  {codeExpanded ? '▾' : '▸'} Code
                </div>
                {codeExpanded && nodeDetail?.declaration?.body && (
                  <div className={styles.codeBlock}>
                    {codeLines.map((line, i) => (
                      <div key={i}>
                        <LeanCodeLine text={line} tokens={highlightedCodeLines[i]} />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Milestones */}
              {nodeDetail?.milestones && nodeDetail.milestones.length > 0 && (
                <div className={styles.milestonesSection}>
                  <div className={styles.milestonesSectionLabel}>Milestone history</div>
                  {nodeDetail.milestones.map((m, i) => (
                    <div
                      key={i}
                      className={styles.milestoneEntry}
                      style={{ borderLeftColor: STATUS_COLORS[m.status] || 'var(--border)' }}
                    >
                      <div className={styles.milestoneEntryHeader}>
                        <span className={styles.milestoneSession}>
                          {m.sessionId.replace('session_', '#')}
                        </span>
                        <span
                          className={styles.milestoneStatus}
                          style={{ color: STATUS_COLORS[m.status] || 'var(--text-muted)' }}
                        >
                          {m.status}
                        </span>
                      </div>
                      {m.blocker && (
                        <div className={styles.milestoneBlocker}>Blocker: {m.blocker}</div>
                      )}
                      {m.nextSteps && (
                        <div className={styles.milestoneNext}>Next: {m.nextSteps}</div>
                      )}
                      {m.keyLemmas && m.keyLemmas.length > 0 && (
                        <div className={styles.milestoneLemmas}>
                          Lemmas: {m.keyLemmas.join(', ')}
                        </div>
                      )}
                      {Array.isArray(m.attempts) && m.attempts.length > 0 && (
                        <div className={styles.milestoneAttempts}>
                          {(m.attempts as any[]).map((att, ai) => (
                            <AttemptCard key={ai} att={att} />
                          ))}
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

      {/* ── Timeline ── */}
      {timelineData && timelineData.length > 0 && (
        <div className={styles.timeline}>
          <div className={styles.timelineHeader}>
            <span className={styles.timelineTitle}>Sorry count per iteration</span>
            {timelineData.length > 0 && (
              <span
                className={styles.timelineTotal}
                style={{
                  color: timelineData[timelineData.length - 1].totalSorry === 0
                    ? '#28a745'
                    : '#e36209',
                }}
              >
                Current: {timelineData[timelineData.length - 1].totalSorry}
              </span>
            )}
          </div>
          <div className={styles.timelineChart}>
            {timelineData.map((point, i) => {
              const heightPct = (point.totalSorry / timelineMax) * 100;
              const isActive = i === selectedTimelineIdx;
              const barColor = point.totalSorry === 0 ? '#28a745' : '#e36209';
              return (
                <div
                  key={i}
                  className={`${styles.timelineBar} ${isActive ? styles.timelineBarActive : ''}`}
                  style={{
                    height: `${Math.max(heightPct, 4)}%`,
                    background: barColor,
                    opacity: isActive ? 1 : 0.6,
                  }}
                  onClick={() => setSelectedTimelineIdx(i === selectedTimelineIdx ? -1 : i)}
                  title={`${point.iteration}: ${point.totalSorry} sorry`}
                >
                  <span className={styles.timelineBarLabel}>{point.totalSorry}</span>
                </div>
              );
            })}
          </div>
          <div className={styles.timelineLabels}>
            {timelineData.map((point, i) => (
              <div key={i} className={styles.timelineIterLabel}>
                {point.iteration.replace('iter-', '#')}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}