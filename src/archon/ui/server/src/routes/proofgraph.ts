/**
 * Proof Graph API v4
 *
 * Key fix: snapshot/:iteration now builds a COMPLETE project view by walking
 * backwards through all iterations ≤ the selected one and using the most
 * recent snapshot for each file slug. Files not in any snapshot fall back
 * to the current project .lean files. This ensures the graph always shows
 * the full set of declarations, not just the subset modified in one iteration.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { countSorryInLean } from '../utils/sorryCount.js';
import type { ProjectPaths } from './project.js';

const DECL_RE = /^(noncomputable\s+)?(private\s+)?(protected\s+)?(theorem|lemma|def|instance|class|structure|inductive|abbrev|example)\s+([^\s:(\[{]+)/;

interface LeanDecl {
  kind: string; name: string; file: string; line: number; endLine: number;
  hasSorry: boolean; sorryCount: number; signature: string; body: string; usedNames: string[];
}

function parseLeanContent(content: string, relPath: string): LeanDecl[] {
  const lines = content.split('\n');
  const sorryLines = new Set(countSorryInLean(content).map(o => o.line));
  const decls: LeanDecl[] = []; let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(DECL_RE);
    if (!m) { i++; continue; }
    const kind = m[4], name = m[5], start = i + 1;
    let end = start, bd = 0;
    for (let j = i; j < lines.length; j++) {
      for (const ch of lines[j]) { if (ch === '{' || ch === '⟨') bd++; if (ch === '}' || ch === '⟩') bd--; }
      if (j > i && bd <= 0 && j + 1 < lines.length && lines[j + 1].trim() && DECL_RE.test(lines[j + 1].trim())) { end = j + 1; break; }
      end = j + 1;
    }
    let sc = 0; for (let l = start; l <= end; l++) if (sorryLines.has(l)) sc++;
    const body = lines.slice(i, i + (end - start)).join('\n');
    decls.push({ kind, name, file: relPath, line: start, endLine: end, hasSorry: sc > 0, sorryCount: sc, signature: lines[i].trim(), body, usedNames: extractRefs(body) });
    i = end;
  }
  return decls;
}

function parseLeanFile(fp: string, rel: string): LeanDecl[] {
  try { return parseLeanContent(fs.readFileSync(fp, 'utf-8'), rel); } catch { return []; }
}

function extractRefs(body: string): string[] {
  const KW = new Set(['import','open','namespace','section','end','variable','universe','theorem','lemma','def','instance','class','structure','inductive','abbrev','example','by','where','fun','match','with','if','then','else','let','in','have','show','from','intro','simp','rw','rfl','exact','apply','constructor','cases','induction','sorry','calc','do','return','pure','true','false','Type','Prop','Sort','noncomputable','private','protected','partial','unsafe','mutual']);
  const re = /\b([A-Za-z_][A-Za-z0-9_.']*)\b/g;
  const ns = new Set<string>(); let m;
  while ((m = re.exec(body)) !== null) { const b = m[1].split('.')[0]; if (!KW.has(b) && b.length > 1) ns.add(b); }
  return Array.from(ns);
}

function buildEdges(decls: LeanDecl[]) {
  const mp = new Map<string, string>(); for (const d of decls) mp.set(d.name, `${d.file}::${d.name}`);
  const out: { from: string; to: string }[] = []; const seen = new Set<string>();
  for (const d of decls) { const fk = `${d.file}::${d.name}`; for (const r of d.usedNames) { const tk = mp.get(r); if (tk && tk !== fk) { const ek = `${fk}->${tk}`; if (!seen.has(ek)) { seen.add(ek); out.push({ from: fk, to: tk }); } } } }
  return out;
}

// ── Milestones ───────────────────────────────────────────────────────

function getAllMilestones(archonPath: string) {
  const dir = path.join(archonPath, 'proof-journal', 'sessions');
  if (!fs.existsSync(dir)) return new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  const res = new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  for (const sd of fs.readdirSync(dir).filter(d => d.startsWith('session_')).sort()) {
    const mf = path.join(dir, sd, 'milestones.jsonl'); if (!fs.existsSync(mf)) continue;
    for (const line of fs.readFileSync(mf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line); const t = m.target || {};
        const f = (t.file || '').replace(/\\/g, '/'), th = t.theorem || ''; if (!f || !th) continue;
        const keys = [`${f}::${th}`, `${path.basename(f)}::${th}`];
        const att = Array.isArray(m.attempts) ? m.attempts.length : 0;
        for (const k of keys) {
          const ex = res.get(k);
          if (ex) { ex.totalAttempts += att; ex.latestStatus = m.status || ex.latestStatus; if (!ex.sessions.includes(sd)) ex.sessions.push(sd); if (m.findings?.blocker) ex.blocker = m.findings.blocker; }
          else res.set(k, { totalAttempts: att, latestStatus: m.status || 'unknown', sessions: [sd], blocker: m.findings?.blocker });
        }
      } catch { /* */ }
    }
  }
  return res;
}

function getMilestonesForNode(archonPath: string, file: string, theorem: string, maxIter?: string) {
  const dir = path.join(archonPath, 'proof-journal', 'sessions');
  if (!fs.existsSync(dir)) return [];
  let maxN = Infinity;
  if (maxIter) { const n = parseInt(maxIter.replace('iter-', ''), 10); if (!isNaN(n)) maxN = n; }
  const out: any[] = [];
  for (const sd of fs.readdirSync(dir).filter(d => d.startsWith('session_')).sort()) {
    const sn = parseInt(sd.replace('session_', ''), 10); if (!isNaN(sn) && sn > maxN) continue;
    const mf = path.join(dir, sd, 'milestones.jsonl'); if (!fs.existsSync(mf)) continue;
    for (const line of fs.readFileSync(mf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line); const t = m.target || {};
        const mf2 = (t.file || '').replace(/\\/g, '/');
        if ((file.endsWith(mf2) || mf2.endsWith(file) || path.basename(mf2) === path.basename(file)) && t.theorem === theorem)
          out.push({ sessionId: sd, status: m.status || 'unknown', attempts: m.attempts || [], blocker: m.findings?.blocker, nextSteps: m.next_steps, keyLemmas: m.findings?.key_lemmas_used });
      } catch { /* */ }
    }
  }
  return out;
}

// ── Snapshot helpers ─────────────────────────────────────────────────

function getSnapshotIterations(logsPath: string): string[] {
  if (!fs.existsSync(logsPath)) return [];
  return fs.readdirSync(logsPath).filter(d => {
    if (!d.startsWith('iter-')) return false;
    const sd = path.join(logsPath, d, 'snapshots'); if (!fs.existsSync(sd)) return false;
    for (const s of fs.readdirSync(sd)) { const p = path.join(sd, s); if (fs.statSync(p).isDirectory() && fs.readdirSync(p).some(f => f.startsWith('step-') && f.endsWith('.lean'))) return true; }
    return false;
  }).sort();
}

/** For a given iteration, find the latest .lean content per slug by walking
 *  backwards through all iterations ≤ target. Returns Map<slug, content>. */
function resolveFullSnapshotState(logsPath: string, targetIter: string): Map<string, { content: string; displayName: string }> {
  const allIters = fs.readdirSync(logsPath)
    .filter(d => d.startsWith('iter-') && d <= targetIter && fs.existsSync(path.join(logsPath, d, 'snapshots')))
    .sort();

  const best = new Map<string, { content: string; displayName: string }>();

  // Walk forward so later iterations overwrite earlier ones
  for (const iter of allIters) {
    const sd = path.join(logsPath, iter, 'snapshots');
    if (!fs.existsSync(sd)) continue;
    for (const slug of fs.readdirSync(sd)) {
      const slugDir = path.join(sd, slug);
      if (!fs.statSync(slugDir).isDirectory()) continue;
      const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
      const latest = files[files.length - 1];
      if (!latest) continue;
      try {
        const content = fs.readFileSync(path.join(slugDir, latest), 'utf-8');
        best.set(slug, { content, displayName: slug.replace(/_/g, '/') + '.lean' });
      } catch { /* */ }
    }
  }
  return best;
}

function buildSnapshotTimeline(logsPath: string, projectPath: string) {
  const iters = getSnapshotIterations(logsPath);
  return iters.map(iterDir => {
    let timestamp: string | undefined;
    try { const m = JSON.parse(fs.readFileSync(path.join(logsPath, iterDir, 'meta.json'), 'utf-8')); timestamp = m.completedAt || m.startedAt; } catch { /* */ }

    // Full state at this iteration
    const state = resolveFullSnapshotState(logsPath, iterDir);
    const perFile: Record<string, number> = {};
    const perDecl: Record<string, { hasSorry: boolean; sorryCount: number }> = {};
    let total = 0;
    for (const [, { content, displayName }] of state) {
      const sc = countSorryInLean(content).length;
      perFile[displayName] = sc; total += sc;
      for (const d of parseLeanContent(content, displayName))
        perDecl[`${displayName}::${d.name}`] = { hasSorry: d.hasSorry, sorryCount: d.sorryCount };
    }
    return { iteration: iterDir, timestamp, totalSorry: total, perFile, perDeclaration: perDecl };
  });
}

/** Build full graph at a specific iteration using accumulated snapshots + project fallback */
function buildGraphAtIteration(logsPath: string, projectPath: string, iteration: string) {
  const snapState = resolveFullSnapshotState(logsPath, iteration);
  const allDecls: LeanDecl[] = [];
  const coveredFiles = new Set<string>();

  // Snapshot files first
  for (const [, { content, displayName }] of snapState) {
    allDecls.push(...parseLeanContent(content, displayName));
    coveredFiles.add(displayName);
  }

  // Fallback: project .lean files not covered by any snapshot
  (function walk(dir: string) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const f = path.join(dir, e.name);
        if (e.isDirectory()) { if (!['_lake', '.lake', '.archon', 'node_modules', '.git'].includes(e.name)) walk(f); }
        else if (e.isFile() && e.name.endsWith('.lean')) {
          const rel = path.relative(projectPath, f);
          if (!coveredFiles.has(rel)) allDecls.push(...parseLeanFile(f, rel));
        }
      }
    } catch { /* */ }
  })(projectPath);

  const edges = buildEdges(allDecls);
  const fg: Record<string, { file: string; declarations: string[] }> = {};
  for (const d of allDecls) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }

  return {
    declarations: allDecls.map(d => ({
      id: `${d.file}::${d.name}`, kind: d.kind, name: d.name, file: d.file,
      line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature,
      totalAttempts: 0, latestMilestoneStatus: undefined, milestoneSessions: [] as string[], blocker: undefined,
    })),
    edges, files: Object.values(fg),
  };
}

/** Find decl body at a specific iteration, walking backwards through snapshots */
function findDeclAtIteration(logsPath: string, projectPath: string, iteration: string, file: string, name: string): LeanDecl | undefined {
  const state = resolveFullSnapshotState(logsPath, iteration);
  const slug = file.replace(/\.lean$/, '').replace(/\//g, '_');
  const entry = state.get(slug);
  if (entry) {
    const decl = parseLeanContent(entry.content, file).find(d => d.name === name);
    if (decl) return decl;
  }
  // Fallback to project
  return parseLeanFile(path.join(projectPath, file), file).find(d => d.name === name);
}

// ── Register routes ──────────────────────────────────────────────────

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { projectPath, archonPath, logsPath } = paths;

  fastify.get('/api/proofgraph/declarations', async () => {
    const allDecls: LeanDecl[] = [];
    (function walk(dir: string) {
      try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (!['_lake','.lake','.archon','node_modules','.git'].includes(e.name)) walk(f); } else if (e.isFile() && e.name.endsWith('.lean')) allDecls.push(...parseLeanFile(f, path.relative(projectPath, f))); } } catch { /* */ }
    })(projectPath);
    const edges = buildEdges(allDecls);
    const ms = getAllMilestones(archonPath);
    const fg: Record<string, { file: string; declarations: string[] }> = {};
    for (const d of allDecls) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }
    return {
      declarations: allDecls.map(d => {
        const id = `${d.file}::${d.name}`;
        let mi = ms.get(id); if (!mi) { for (const [k, v] of ms) { if (k.split('::')[1] === d.name) { mi = v; break; } } }
        return { id, kind: d.kind, name: d.name, file: d.file, line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature, totalAttempts: mi?.totalAttempts ?? 0, latestMilestoneStatus: mi?.latestStatus, milestoneSessions: mi?.sessions ?? [], blocker: mi?.blocker };
      }),
      edges, files: Object.values(fg),
    };
  });

  fastify.get('/api/proofgraph/timeline', async () => buildSnapshotTimeline(logsPath, projectPath));

  fastify.get<{ Params: { iteration: string } }>('/api/proofgraph/snapshot/:iteration', async (req, reply) => {
    const { iteration } = req.params;
    if (!iteration.startsWith('iter-')) return reply.status(400).send({ error: 'Invalid' });
    return buildGraphAtIteration(logsPath, projectPath, iteration);
  });

  fastify.get<{ Params: { file: string; name: string }; Querystring: { iteration?: string } }>(
    '/api/proofgraph/node/:file/:name', async (req) => {
      const file = decodeURIComponent(req.params.file), { name } = req.params, iter = req.query.iteration;
      const decl = iter
        ? findDeclAtIteration(logsPath, projectPath, iter, file, name)
        : parseLeanFile(path.join(projectPath, file), file).find(d => d.name === name);
      return {
        declaration: decl ? { id: `${decl.file}::${decl.name}`, kind: decl.kind, name: decl.name, file: decl.file, line: decl.line, endLine: decl.endLine, hasSorry: decl.hasSorry, sorryCount: decl.sorryCount, signature: decl.signature, body: decl.body } : null,
        milestones: getMilestonesForNode(archonPath, file, name, iter),
      };
    },
  );
}