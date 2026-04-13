/**
 * Proof Graph API — declaration graph, dependency extraction, sorry timeline
 *
 * Endpoints:
 *   GET /api/proofgraph/declarations
 *     → All declarations across .lean files with sorry status + dependency edges
 *
 *   GET /api/proofgraph/timeline
 *     → Per-iteration sorry counts (global + per-file) for the timeline scrubber
 *
 *   GET /api/proofgraph/node/:file/:name
 *     → Detail for a single node: code, milestone history, attempt history
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { readFileOr } from '../utils.js';
import { countSorryInLean } from '../utils/sorryCount.js';
import type { ProjectPaths } from './project.js';

// ── Lean parser helpers ──────────────────────────────────────────────

interface LeanDeclaration {
  kind: 'theorem' | 'lemma' | 'def' | 'instance' | 'class' | 'structure' | 'inductive' | 'abbrev' | 'example';
  name: string;
  file: string;
  line: number;
  endLine: number;
  hasSorry: boolean;
  sorryCount: number;
  signature: string;    // first line of the declaration
  body: string;         // full declaration text (truncated)
  usedNames: string[];  // identifiers referenced in the body
}

interface DependencyEdge {
  from: string;  // "file::name"
  to: string;    // "file::name"
}

const DECL_RE = /^(noncomputable\s+)?(private\s+)?(protected\s+)?(theorem|lemma|def|instance|class|structure|inductive|abbrev|example)\s+([^\s:(\[{]+)/;

function parseLeanFile(filePath: string, relPath: string): LeanDeclaration[] {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const lines = content.split('\n');
  const sorryOccurrences = countSorryInLean(content);
  const sorryLines = new Set(sorryOccurrences.map(o => o.line));

  const decls: LeanDeclaration[] = [];
  let i = 0;

  while (i < lines.length) {
    const match = lines[i].match(DECL_RE);
    if (!match) {
      i++;
      continue;
    }

    const kind = match[4] as LeanDeclaration['kind'];
    const name = match[5];
    const startLine = i + 1;

    // Find end of declaration (heuristic: next top-level decl or end of file)
    let endLine = startLine;
    let braceDepth = 0;
    let foundBody = false;
    for (let j = i; j < lines.length; j++) {
      const line = lines[j];
      for (const ch of line) {
        if (ch === '{' || ch === '⟨') braceDepth++;
        if (ch === '}' || ch === '⟩') braceDepth--;
      }
      if (j > i && braceDepth <= 0) {
        // Check if next non-empty line starts a new declaration
        if (j + 1 < lines.length) {
          const nextLine = lines[j + 1].trim();
          if (nextLine && DECL_RE.test(nextLine)) {
            endLine = j + 1;
            foundBody = true;
            break;
          }
        }
      }
      if (line.includes(':=') || line.includes('where') || line.includes('by')) {
        foundBody = true;
      }
      endLine = j + 1;
    }
    if (!foundBody) endLine = Math.min(startLine + 50, lines.length);

    // Count sorries in this declaration's range
    let declSorryCount = 0;
    for (let ln = startLine; ln <= endLine; ln++) {
      if (sorryLines.has(ln)) declSorryCount++;
    }

    // Extract body text (truncated)
    const bodyLines = lines.slice(i, Math.min(i + (endLine - startLine), i + 100));
    const body = bodyLines.join('\n');

    // Extract referenced identifiers (very simple heuristic)
    const usedNames = extractReferencedNames(body);

    decls.push({
      kind,
      name,
      file: relPath,
      line: startLine,
      endLine,
      hasSorry: declSorryCount > 0,
      sorryCount: declSorryCount,
      signature: lines[i].trim(),
      body: body.length > 3000 ? body.slice(0, 3000) + '\n...(truncated)' : body,
      usedNames,
    });

    i = endLine;
  }

  return decls;
}

function extractReferencedNames(body: string): string[] {
  // Extract identifiers that could be references to other declarations
  // Skip Lean keywords, tactics, etc.
  const KEYWORDS = new Set([
    'import', 'open', 'namespace', 'section', 'end', 'variable', 'universe',
    'theorem', 'lemma', 'def', 'instance', 'class', 'structure', 'inductive', 'abbrev', 'example',
    'by', 'where', 'fun', 'match', 'with', 'if', 'then', 'else', 'let', 'in', 'have', 'show',
    'from', 'intro', 'simp', 'rw', 'rfl', 'exact', 'apply', 'constructor', 'cases', 'induction',
    'sorry', 'calc', 'do', 'return', 'pure', 'true', 'false', 'Type', 'Prop', 'Sort',
    'noncomputable', 'private', 'protected', 'partial', 'unsafe', 'mutual',
  ]);

  const identRe = /\b([A-Za-z_][A-Za-z0-9_.']*)\b/g;
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = identRe.exec(body)) !== null) {
    const id = m[1];
    if (!KEYWORDS.has(id) && id.length > 1 && !/^\d/.test(id)) {
      // Take the base name (before any dot)
      const base = id.split('.')[0];
      if (base.length > 1 && !KEYWORDS.has(base)) {
        names.add(base);
      }
    }
  }
  return Array.from(names);
}

function buildDependencyEdges(decls: LeanDeclaration[]): DependencyEdge[] {
  // Build a map from name → declaration key
  const nameToKey = new Map<string, string>();
  for (const d of decls) {
    nameToKey.set(d.name, `${d.file}::${d.name}`);
  }

  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();

  for (const d of decls) {
    const fromKey = `${d.file}::${d.name}`;
    for (const ref of d.usedNames) {
      const toKey = nameToKey.get(ref);
      if (toKey && toKey !== fromKey) {
        const edgeKey = `${fromKey}->${toKey}`;
        if (!seen.has(edgeKey)) {
          seen.add(edgeKey);
          edges.push({ from: fromKey, to: toKey });
        }
      }
    }
  }

  return edges;
}

// ── Sorry timeline from iteration snapshots / sorry count ────────────

interface TimelinePoint {
  iteration: string;
  timestamp?: string;
  totalSorry: number;
  perFile: Record<string, number>;
}

function buildSorryTimeline(logsPath: string, projectPath: string): TimelinePoint[] {
  const timeline: TimelinePoint[] = [];

  if (!fs.existsSync(logsPath)) return timeline;

  const iterDirs = fs.readdirSync(logsPath)
    .filter(d => d.startsWith('iter-') && fs.statSync(path.join(logsPath, d)).isDirectory())
    .sort();

  for (const iterDir of iterDirs) {
    const metaFile = path.join(logsPath, iterDir, 'meta.json');
    let timestamp: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
      timestamp = meta.startedAt || meta.completedAt;
    } catch { /* ignore */ }

    // Try to get sorry count from snapshots (baseline = before, latest step = after)
    const snapshotsDir = path.join(logsPath, iterDir, 'snapshots');
    const perFile: Record<string, number> = {};
    let totalSorry = 0;

    if (fs.existsSync(snapshotsDir)) {
      for (const slug of fs.readdirSync(snapshotsDir)) {
        const slugDir = path.join(snapshotsDir, slug);
        if (!fs.statSync(slugDir).isDirectory()) continue;

        // Find the latest snapshot file
        const files = fs.readdirSync(slugDir)
          .filter(f => f.endsWith('.lean'))
          .sort();
        const latestFile = files[files.length - 1];
        if (!latestFile) continue;

        try {
          const content = fs.readFileSync(path.join(slugDir, latestFile), 'utf-8');
          const count = countSorryInLean(content).length;
          const displayName = slug.replace(/_/g, '/') + '.lean';
          perFile[displayName] = count;
          totalSorry += count;
        } catch { /* ignore */ }
      }
    }

    // If no snapshots, try counting from actual .lean files at that point
    // (only for the last iteration as a fallback)
    if (Object.keys(perFile).length === 0 && iterDir === iterDirs[iterDirs.length - 1]) {
      // Use current project state
      function walkLean(dir: string) {
        let entries: fs.Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (['_lake', '.lake', '.archon', 'node_modules'].includes(entry.name)) continue;
            walkLean(full);
          } else if (entry.isFile() && entry.name.endsWith('.lean')) {
            try {
              const content = fs.readFileSync(full, 'utf-8');
              const count = countSorryInLean(content).length;
              if (count > 0) {
                const rel = path.relative(projectPath, full);
                perFile[rel] = count;
                totalSorry += count;
              }
            } catch { /* ignore */ }
          }
        }
      }
      walkLean(projectPath);
    }

    timeline.push({ iteration: iterDir, timestamp, totalSorry, perFile });
  }

  return timeline;
}

// ── Milestone cross-reference ────────────────────────────────────────

interface NodeMilestoneInfo {
  sessionId: string;
  status: string;
  attempts: unknown[];
  blocker?: string;
  nextSteps?: string;
  keyLemmas?: string[];
}

function getMilestonesForNode(
  archonPath: string,
  file: string,
  theorem: string,
): NodeMilestoneInfo[] {
  const sessionsDir = path.join(archonPath, 'proof-journal', 'sessions');
  if (!fs.existsSync(sessionsDir)) return [];

  const results: NodeMilestoneInfo[] = [];
  const sessionDirs = fs.readdirSync(sessionsDir)
    .filter(d => d.startsWith('session_'))
    .sort();

  for (const sessionDir of sessionDirs) {
    const milestonesFile = path.join(sessionsDir, sessionDir, 'milestones.jsonl');
    if (!fs.existsSync(milestonesFile)) continue;

    const content = fs.readFileSync(milestonesFile, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        const target = m.target || {};
        // Match by file basename or full path, and theorem name
        const mFile = (target.file || '').replace(/\\/g, '/');
        const matchFile = file.endsWith(mFile) || mFile.endsWith(file) ||
          path.basename(mFile) === path.basename(file);
        const matchTheorem = target.theorem === theorem;

        if (matchFile && matchTheorem) {
          results.push({
            sessionId: sessionDir,
            status: m.status || 'unknown',
            attempts: m.attempts || [],
            blocker: m.findings?.blocker,
            nextSteps: m.next_steps,
            keyLemmas: m.findings?.key_lemmas_used,
          });
        }
      } catch { /* ignore parse errors */ }
    }
  }

  return results;
}

// ── Register routes ──────────────────────────────────────────────────

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { projectPath, archonPath, logsPath } = paths;

  // All declarations + edges
  fastify.get('/api/proofgraph/declarations', async () => {
    const allDecls: LeanDeclaration[] = [];

    function walkLean(dir: string) {
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (['_lake', '.lake', '.archon', 'node_modules', '.git'].includes(entry.name)) continue;
          walkLean(full);
        } else if (entry.isFile() && entry.name.endsWith('.lean')) {
          const rel = path.relative(projectPath, full);
          allDecls.push(...parseLeanFile(full, rel));
        }
      }
    }
    walkLean(projectPath);

    const edges = buildDependencyEdges(allDecls);

    // Build file groups
    const fileGroups: Record<string, { file: string; declarations: string[] }> = {};
    for (const d of allDecls) {
      if (!fileGroups[d.file]) {
        fileGroups[d.file] = { file: d.file, declarations: [] };
      }
      fileGroups[d.file].declarations.push(d.name);
    }

    return {
      declarations: allDecls.map(d => ({
        id: `${d.file}::${d.name}`,
        kind: d.kind,
        name: d.name,
        file: d.file,
        line: d.line,
        hasSorry: d.hasSorry,
        sorryCount: d.sorryCount,
        signature: d.signature,
      })),
      edges,
      files: Object.values(fileGroups),
    };
  });

  // Sorry timeline across iterations
  fastify.get('/api/proofgraph/timeline', async () => {
    return buildSorryTimeline(logsPath, projectPath);
  });

  // Node detail with milestone history
  fastify.get<{ Params: { file: string; name: string } }>(
    '/api/proofgraph/node/:file/:name',
    async (req) => {
      const { file, name } = req.params;
      const decodedFile = decodeURIComponent(file);

      // Find the declaration
      const fullPath = path.join(projectPath, decodedFile);
      const decls = parseLeanFile(fullPath, decodedFile);
      const decl = decls.find(d => d.name === name);

      // Get milestone history
      const milestones = getMilestonesForNode(archonPath, decodedFile, name);

      return {
        declaration: decl ? {
          id: `${decl.file}::${decl.name}`,
          kind: decl.kind,
          name: decl.name,
          file: decl.file,
          line: decl.line,
          endLine: decl.endLine,
          hasSorry: decl.hasSorry,
          sorryCount: decl.sorryCount,
          signature: decl.signature,
          body: decl.body,
        } : null,
        milestones,
      };
    },
  );
}