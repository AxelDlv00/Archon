import { useQuery } from '@tanstack/react-query';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

// ── Types ────────────────────────────────────────────────────────────

export interface GraphDeclaration {
  id: string;       // "file::name"
  kind: string;
  name: string;
  file: string;
  line: number;
  hasSorry: boolean;
  sorryCount: number;
  signature: string;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphFileGroup {
  file: string;
  declarations: string[];
}

export interface DeclarationsResponse {
  declarations: GraphDeclaration[];
  edges: GraphEdge[];
  files: GraphFileGroup[];
}

export interface TimelinePoint {
  iteration: string;
  timestamp?: string;
  totalSorry: number;
  perFile: Record<string, number>;
}

export interface NodeMilestoneInfo {
  sessionId: string;
  status: string;
  attempts: unknown[];
  blocker?: string;
  nextSteps?: string;
  keyLemmas?: string[];
}

export interface NodeDetail {
  declaration: {
    id: string;
    kind: string;
    name: string;
    file: string;
    line: number;
    endLine: number;
    hasSorry: boolean;
    sorryCount: number;
    signature: string;
    body: string;
  } | null;
  milestones: NodeMilestoneInfo[];
}

// ── Hooks ────────────────────────────────────────────────────────────

export function useProofGraphDeclarations() {
  return useQuery<DeclarationsResponse>({
    queryKey: ['proofgraphDeclarations'],
    queryFn: () => fetchJson('/api/proofgraph/declarations'),
    refetchInterval: 15000,
  });
}

export function useProofGraphTimeline() {
  return useQuery<TimelinePoint[]>({
    queryKey: ['proofgraphTimeline'],
    queryFn: () => fetchJson('/api/proofgraph/timeline'),
    refetchInterval: 15000,
  });
}

export function useProofGraphNodeDetail(file: string, name: string) {
  return useQuery<NodeDetail>({
    queryKey: ['proofgraphNode', file, name],
    queryFn: () => fetchJson(`/api/proofgraph/node/${encodeURIComponent(file)}/${encodeURIComponent(name)}`),
    enabled: !!file && !!name,
  });
}