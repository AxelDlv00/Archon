/**
 * Proof Graph API v3
 *
 *   GET /api/proofgraph/declarations        → current project state
 *   GET /api/proofgraph/timeline            → only snapshot iterations
 *   GET /api/proofgraph/snapshot/:iteration → declarations from snapshot
 *   GET /api/proofgraph/node/:file/:name?iteration=  → code + milestones (iteration-aware)
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { countSorryInLean } from '../utils/sorryCount.js';
import type { ProjectPaths } from './project.js';

const DECL_RE = /^(noncomputable\s+)?(private\s+)?(protected\s+)?(theorem|lemma|def|instance|class|structure|inductive|abbrev|example)\s+([^\s:(\[{]+)/;

interface LeanDeclaration {
  kind: string; name: string; file: string; line: number; endLine: number;
  hasSorry: boolean; sorryCount: number; signature: string; body: string; usedNames: string[];
}

function parseLeanContent(content: string, relPath: string): LeanDeclaration[] {
  const lines = content.split('\n');
  const sorryLines = new Set(countSorryInLean(content).map(o => o.line));
  const decls: LeanDeclaration[] = [];
  let i = 0;
  while (i < lines.length) {
    const match = lines[i].match(DECL_RE);
    if (!match) { i++; continue; }
    const kind = match[4]; const name = match[5]; const startLine = i + 1;
    let endLine = startLine; let braceDepth = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{' || ch === '⟨') braceDepth++; if (ch === '}' || ch === '⟩') braceDepth--; }
      if (j > i && braceDepth <= 0 && j + 1 < lines.length) {
        const nl = lines[j + 1].trim();
        if (nl && DECL_RE.test(nl)) { endLine = j + 1; break; }
      }
      endLine = j + 1;
    }
    let sc = 0; for (let ln = startLine; ln <= endLine; ln++) { if (sorryLines.has(ln)) sc++; }
    const body = lines.slice(i, i + (endLine - startLine)).join('\n');
    decls.push({ kind, name, file: relPath, line: startLine, endLine, hasSorry: sc > 0, sorryCount: sc, signature: lines[i].trim(), body, usedNames: extractRefs(body) });
    i = endLine;
  }
  return decls;
}

function parseLeanFile(filePath: string, relPath: string): LeanDeclaration[] {
  try { return parseLeanContent(fs.readFileSync(filePath, 'utf-8'), relPath); } catch { return []; }
}

function extractRefs(body: string): string[] {
  const KW = new Set(['import','open','namespace','section','end','variable','universe','theorem','lemma','def','instance','class','structure','inductive','abbrev','example','by','where','fun','match','with','if','then','else','let','in','have','show','from','intro','simp','rw','rfl','exact','apply','constructor','cases','induction','sorry','calc','do','return','pure','true','false','Type','Prop','Sort','noncomputable','private','protected','partial','unsafe','mutual']);
  const re = /\b([A-Za-z_][A-Za-z0-9_.']*)\b/g;
  const names = new Set<string>(); let m;
  while ((m = re.exec(body)) !== null) { const b = m[1].split('.')[0]; if (!KW.has(b) && b.length > 1) names.add(b); }
  return Array.from(names);
}

function buildEdges(decls: LeanDeclaration[]) {
  const map = new Map<string, string>(); for (const d of decls) map.set(d.name, `${d.file}::${d.name}`);
  const edges: { from: string; to: string }[] = []; const seen = new Set<string>();
  for (const d of decls) { const fk = `${d.file}::${d.name}`; for (const r of d.usedNames) { const tk = map.get(r); if (tk && tk !== fk) { const ek = `${fk}->${tk}`; if (!seen.has(ek)) { seen.add(ek); edges.push({ from: fk, to: tk }); } } } }
  return edges;
}

function getAllMilestones(archonPath: string) {
  const dir = path.join(archonPath, 'proof-journal', 'sessions');
  if (!fs.existsSync(dir)) return new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  const result = new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  for (const sd of fs.readdirSync(dir).filter(d => d.startsWith('session_')).sort()) {
    const mf = path.join(dir, sd, 'milestones.jsonl');
    if (!fs.existsSync(mf)) continue;
    for (const line of fs.readFileSync(mf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line); const t = m.target || {};
        const file = (t.file || '').replace(/\\/g, '/'); const theorem = t.theorem || '';
        if (!file || !theorem) continue;
        const keys = [`${file}::${theorem}`, `${path.basename(file)}::${theorem}`];
        const att = Array.isArray(m.attempts) ? m.attempts.length : 0;
        for (const key of keys) {
          const ex = result.get(key);
          if (ex) { ex.totalAttempts += att; ex.latestStatus = m.status || ex.latestStatus; if (!ex.sessions.includes(sd)) ex.sessions.push(sd); if (m.findings?.blocker) ex.blocker = m.findings.blocker; }
          else result.set(key, { totalAttempts: att, latestStatus: m.status || 'unknown', sessions: [sd], blocker: m.findings?.blocker });
        }
      } catch { /* skip */ }
    }
  }
  return result;
}

/** Get milestones for a node, optionally filtered to sessions up to a given iteration */
function getMilestonesForNode(archonPath: string, file: string, theorem: string, maxIteration?: string) {
  const dir = path.join(archonPath, 'proof-journal', 'sessions');
  if (!fs.existsSync(dir)) return [];
  const results: any[] = [];
  // Determine which sessions to include
  let maxSessionNum = Infinity;
  if (maxIteration) {
    // Iteration iter-003 roughly maps to session_3 (they're created in order)
    const iterNum = parseInt(maxIteration.replace('iter-', ''), 10);
    if (!isNaN(iterNum)) maxSessionNum = iterNum;
  }
  for (const sd of fs.readdirSync(dir).filter(d => d.startsWith('session_')).sort()) {
    const sessionNum = parseInt(sd.replace('session_', ''), 10);
    if (!isNaN(sessionNum) && sessionNum > maxSessionNum) continue;
    const mf = path.join(dir, sd, 'milestones.jsonl');
    if (!fs.existsSync(mf)) continue;
    for (const line of fs.readFileSync(mf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line); const t = m.target || {};
        const mFile = (t.file || '').replace(/\\/g, '/');
        if ((file.endsWith(mFile) || mFile.endsWith(file) || path.basename(mFile) === path.basename(file)) && t.theorem === theorem) {
          results.push({ sessionId: sd, status: m.status || 'unknown', attempts: m.attempts || [], blocker: m.findings?.blocker, nextSteps: m.next_steps, keyLemmas: m.findings?.key_lemmas_used });
        }
      } catch { /* skip */ }
    }
  }
  return results;
}

function getSnapshotIterations(logsPath: string): string[] {
  if (!fs.existsSync(logsPath)) return [];
  return fs.readdirSync(logsPath).filter(d => {
    if (!d.startsWith('iter-')) return false;
    const sd = path.join(logsPath, d, 'snapshots');
    if (!fs.existsSync(sd)) return false;
    for (const slug of fs.readdirSync(sd)) {
      const p = path.join(sd, slug);
      if (fs.statSync(p).isDirectory() && fs.readdirSync(p).some(f => f.startsWith('step-') && f.endsWith('.lean'))) return true;
    }
    return false;
  }).sort();
}

function buildSnapshotTimeline(logsPath: string) {
  return getSnapshotIterations(logsPath).map(iterDir => {
    let timestamp: string | undefined;
    try { const m = JSON.parse(fs.readFileSync(path.join(logsPath, iterDir, 'meta.json'), 'utf-8')); timestamp = m.completedAt || m.startedAt; } catch { /* */ }
    const sd = path.join(logsPath, iterDir, 'snapshots');
    const perFile: Record<string, number> = {};
    const perDeclaration: Record<string, { hasSorry: boolean; sorryCount: number }> = {};
    let totalSorry = 0;
    for (const slug of fs.readdirSync(sd)) {
      const slugDir = path.join(sd, slug);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
      const latest = files[files.length - 1]; if (!latest) continue;
      try {
        const content = fs.readFileSync(path.join(slugDir, latest), 'utf-8');
        const sc = countSorryInLean(content).length;
        const dn = slug.replace(/_/g, '/') + '.lean';
        perFile[dn] = sc; totalSorry += sc;
        for (const d of parseLeanContent(content, dn)) perDeclaration[`${dn}::${d.name}`] = { hasSorry: d.hasSorry, sorryCount: d.sorryCount };
      } catch { /* */ }
    }
    return { iteration: iterDir, timestamp, totalSorry, perFile, perDeclaration };
  });
}

/** Parse snapshot at a specific iteration — returns full body for each decl */
function parseSnapshotAtIteration(logsPath: string, iteration: string) {
  const sd = path.join(logsPath, iteration, 'snapshots');
  if (!fs.existsSync(sd)) return { declarations: [], edges: [], files: [] };
  const allDecls: LeanDeclaration[] = [];
  for (const slug of fs.readdirSync(sd)) {
    const slugDir = path.join(sd, slug);
    if (!fs.statSync(slugDir).isDirectory()) continue;
    const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
    const latest = files[files.length - 1]; if (!latest) continue;
    try { allDecls.push(...parseLeanContent(fs.readFileSync(path.join(slugDir, latest), 'utf-8'), slug.replace(/_/g, '/') + '.lean')); } catch { /* */ }
  }
  const edges = buildEdges(allDecls);
  const fg: Record<string, { file: string; declarations: string[] }> = {};
  for (const d of allDecls) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }
  return {
    declarations: allDecls.map(d => ({
      id: `${d.file}::${d.name}`, kind: d.kind, name: d.name, file: d.file,
      line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature,
      body: d.body, // full body from snapshot
      totalAttempts: 0, latestMilestoneStatus: undefined, milestoneSessions: [] as string[], blocker: undefined,
    })),
    edges, files: Object.values(fg),
  };
}

/** Find a declaration body from snapshot at a specific iteration */
function findDeclBodyInSnapshot(logsPath: string, iteration: string, file: string, name: string): string | null {
  const sd = path.join(logsPath, iteration, 'snapshots');
  if (!fs.existsSync(sd)) return null;
  // Derive slug from file: "Foo/Bar.lean" -> "Foo_Bar"
  const slug = file.replace(/\.lean$/, '').replace(/\//g, '_');
  const slugDir = path.join(sd, slug);
  if (!fs.existsSync(slugDir)) return null;
  const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
  const latest = files[files.length - 1];
  if (!latest) return null;
  try {
    const content = fs.readFileSync(path.join(slugDir, latest), 'utf-8');
    const decl = parseLeanContent(content, file).find(d => d.name === name);
    return decl?.body ?? null;
  } catch { return null; }
}

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { projectPath, archonPath, logsPath } = paths;

  fastify.get('/api/proofgraph/declarations', async () => {
    const allDecls: LeanDeclaration[] = [];
    (function walk(dir: string) {
      try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (!['_lake','.lake','.archon','node_modules','.git'].includes(e.name)) walk(f); } else if (e.isFile() && e.name.endsWith('.lean')) allDecls.push(...parseLeanFile(f, path.relative(projectPath, f))); } } catch { /* */ }
    })(projectPath);
    const edges = buildEdges(allDecls);
    const milestones = getAllMilestones(archonPath);
    const fg: Record<string, { file: string; declarations: string[] }> = {};
    for (const d of allDecls) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }
    return {
      declarations: allDecls.map(d => {
        const id = `${d.file}::${d.name}`;
        let ms = milestones.get(id);
        if (!ms) { for (const [k, v] of milestones) { if (k.split('::')[1] === d.name) { ms = v; break; } } }
        return { id, kind: d.kind, name: d.name, file: d.file, line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature, totalAttempts: ms?.totalAttempts ?? 0, latestMilestoneStatus: ms?.latestStatus, milestoneSessions: ms?.sessions ?? [], blocker: ms?.blocker };
      }),
      edges, files: Object.values(fg),
    };
  });

  fastify.get('/api/proofgraph/timeline', async () => buildSnapshotTimeline(logsPath));

  fastify.get<{ Params: { iteration: string } }>('/api/proofgraph/snapshot/:iteration', async (req, reply) => {
    const { iteration } = req.params;
    if (!iteration.startsWith('iter-')) return reply.status(400).send({ error: 'Invalid' });
    return parseSnapshotAtIteration(logsPath, iteration);
  });

  // Node detail: iteration-aware code + milestones
  fastify.get<{ Params: { file: string; name: string }; Querystring: { iteration?: string } }>(
    '/api/proofgraph/node/:file/:name',
    async (req) => {
      const file = decodeURIComponent(req.params.file);
      const { name } = req.params;
      const iteration = req.query.iteration;

      // Get code: from snapshot if iteration specified, else from project
      let decl: LeanDeclaration | undefined;
      if (iteration) {
        const body = findDeclBodyInSnapshot(logsPath, iteration, file, name);
        if (body !== null) {
          // Parse the snapshot version
          const slug = file.replace(/\.lean$/, '').replace(/\//g, '_');
          const slugDir = path.join(logsPath, iteration, 'snapshots', slug);
          const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
          const latest = files[files.length - 1];
          if (latest) {
            const content = fs.readFileSync(path.join(slugDir, latest), 'utf-8');
            decl = parseLeanContent(content, file).find(d => d.name === name);
          }
        }
      }
      if (!decl) {
        decl = parseLeanFile(path.join(projectPath, file), file).find(d => d.name === name);
      }

      // Milestones: filter to sessions ≤ iteration
      const milestones = getMilestonesForNode(archonPath, file, name, iteration);

      return {
        declaration: decl ? { id: `${decl.file}::${decl.name}`, kind: decl.kind, name: decl.name, file: decl.file, line: decl.line, endLine: decl.endLine, hasSorry: decl.hasSorry, sorryCount: decl.sorryCount, signature: decl.signature, body: decl.body } : null,
        milestones,
      };
    },
  );
}