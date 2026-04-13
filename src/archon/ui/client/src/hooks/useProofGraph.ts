import { useQuery } from '@tanstack/react-query';

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

export interface GraphDeclaration {
  id: string; kind: string; name: string; file: string; line: number;
  hasSorry: boolean; sorryCount: number; signature: string;
  totalAttempts: number; latestMilestoneStatus?: string; milestoneSessions: string[]; blocker?: string;
}

export interface GraphEdge { from: string; to: string; }
export interface GraphFileGroup { file: string; declarations: string[]; }

export interface DeclarationsResponse {
  declarations: GraphDeclaration[];
  edges: GraphEdge[];
  files: GraphFileGroup[];
}

export interface TimelinePoint {
  iteration: string; timestamp?: string; totalSorry: number;
  perFile: Record<string, number>;
  perDeclaration: Record<string, { hasSorry: boolean; sorryCount: number }>;
  /** Declaration IDs whose body actually changed compared to previous iteration */
  changedDeclarations: string[];
}

export interface NodeMilestoneInfo {
  sessionId: string; status: string; attempts: unknown[];
  blocker?: string; nextSteps?: string; keyLemmas?: string[];
}

export interface NodeDetail {
  declaration: {
    id: string; kind: string; name: string; file: string;
    line: number; endLine: number; hasSorry: boolean; sorryCount: number;
    signature: string; body: string;
  } | null;
  milestones: NodeMilestoneInfo[];
}

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

/** Snapshot at a specific iteration. keepPreviousData prevents graph flash on switch. */
export function useProofGraphSnapshot(iteration: string) {
  return useQuery<DeclarationsResponse>({
    queryKey: ['proofgraphSnapshot', iteration],
    queryFn: () => fetchJson(`/api/proofgraph/snapshot/${iteration}`),
    enabled: !!iteration,
    placeholderData: (prev) => prev, // keep showing previous data while loading
  });
}

export function useProofGraphNodeDetail(file: string, name: string, iteration?: string) {
  const url = iteration
    ? `/api/proofgraph/node/${encodeURIComponent(file)}/${encodeURIComponent(name)}?iteration=${encodeURIComponent(iteration)}`
    : `/api/proofgraph/node/${encodeURIComponent(file)}/${encodeURIComponent(name)}`;
  return useQuery<NodeDetail>({
    queryKey: ['proofgraphNode', file, name, iteration || ''],
    queryFn: () => fetchJson(url),
    enabled: !!file && !!name,
  });
}