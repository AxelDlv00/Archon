/**
 * Proof Graph API v5
 *
 * Key fix: timeline now returns `changedDeclarations` — the set of declaration IDs
 * whose body text actually changed compared to the previous iteration. This is what
 * the client uses for orange (changed) vs red (unchanged) coloring.
 */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { countSorryInLean } from '../utils/sorryCount.js';
import type { ProjectPaths } from './project.js';

const DECL_RE = /^(noncomputable\s+)?(private\s+)?(protected\s+)?(theorem|lemma|def|instance|class|structure|inductive|abbrev|example)\s+([^\s:(\[{]+)/;

interface LD {
  kind: string; name: string; file: string; line: number; endLine: number;
  hasSorry: boolean; sorryCount: number; signature: string; body: string; usedNames: string[];
}

function parseContent(content: string, rel: string): LD[] {
  const lines = content.split('\n');
  const sl = new Set(countSorryInLean(content).map(o => o.line));
  const ds: LD[] = []; let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(DECL_RE);
    if (!m) { i++; continue; }
    const kind = m[4], name = m[5], s = i + 1;
    let e = s, bd = 0;
    for (let j = i; j < lines.length; j++) {
      for (const c of lines[j]) { if (c === '{' || c === '⟨') bd++; if (c === '}' || c === '⟩') bd--; }
      if (j > i && bd <= 0 && j + 1 < lines.length && lines[j + 1].trim() && DECL_RE.test(lines[j + 1].trim())) { e = j + 1; break; }
      e = j + 1;
    }
    let sc = 0; for (let l = s; l <= e; l++) if (sl.has(l)) sc++;
    const body = lines.slice(i, i + (e - s)).join('\n');
    ds.push({ kind, name, file: rel, line: s, endLine: e, hasSorry: sc > 0, sorryCount: sc, signature: lines[i].trim(), body, usedNames: refs(body) });
    i = e;
  }
  return ds;
}
function parseFile(fp: string, rel: string): LD[] { try { return parseContent(fs.readFileSync(fp, 'utf-8'), rel); } catch { return []; } }

function refs(body: string): string[] {
  const KW = new Set(['import','open','namespace','section','end','variable','universe','theorem','lemma','def','instance','class','structure','inductive','abbrev','example','by','where','fun','match','with','if','then','else','let','in','have','show','from','intro','simp','rw','rfl','exact','apply','constructor','cases','induction','sorry','calc','do','return','pure','true','false','Type','Prop','Sort','noncomputable','private','protected','partial','unsafe','mutual']);
  const re = /\b([A-Za-z_][A-Za-z0-9_.']*)\b/g;
  const ns = new Set<string>(); let m;
  while ((m = re.exec(body)) !== null) { const b = m[1].split('.')[0]; if (!KW.has(b) && b.length > 1) ns.add(b); }
  return Array.from(ns);
}

function edges(ds: LD[]) {
  const mp = new Map<string, string>(); for (const d of ds) mp.set(d.name, `${d.file}::${d.name}`);
  const out: { from: string; to: string }[] = []; const seen = new Set<string>();
  for (const d of ds) { const fk = `${d.file}::${d.name}`; for (const r of d.usedNames) { const tk = mp.get(r); if (tk && tk !== fk) { const ek = `${fk}->${tk}`; if (!seen.has(ek)) { seen.add(ek); out.push({ from: fk, to: tk }); } } } }
  return out;
}

function getAllMilestones(ap: string) {
  const dir = path.join(ap, 'proof-journal', 'sessions');
  if (!fs.existsSync(dir)) return new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  const res = new Map<string, { totalAttempts: number; latestStatus: string; sessions: string[]; blocker?: string }>();
  for (const sd of fs.readdirSync(dir).filter(d => d.startsWith('session_')).sort()) {
    const mf = path.join(dir, sd, 'milestones.jsonl'); if (!fs.existsSync(mf)) continue;
    for (const line of fs.readFileSync(mf, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line); const t = m.target || {};
        const f = (t.file || '').replace(/\\/g, '/'), th = t.theorem || ''; if (!f || !th) continue;
        const att = Array.isArray(m.attempts) ? m.attempts.length : 0;
        for (const k of [`${f}::${th}`, `${path.basename(f)}::${th}`]) {
          const ex = res.get(k);
          if (ex) { ex.totalAttempts += att; ex.latestStatus = m.status || ex.latestStatus; if (!ex.sessions.includes(sd)) ex.sessions.push(sd); if (m.findings?.blocker) ex.blocker = m.findings.blocker; }
          else res.set(k, { totalAttempts: att, latestStatus: m.status || 'unknown', sessions: [sd], blocker: m.findings?.blocker });
        }
      } catch { /* */ }
    }
  }
  return res;
}

function getMilestonesForNode(ap: string, file: string, theorem: string, maxIter?: string) {
  const dir = path.join(ap, 'proof-journal', 'sessions');
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

function snapIters(lp: string): string[] {
  if (!fs.existsSync(lp)) return [];
  return fs.readdirSync(lp).filter(d => {
    if (!d.startsWith('iter-')) return false;
    const sd = path.join(lp, d, 'snapshots'); if (!fs.existsSync(sd)) return false;
    for (const s of fs.readdirSync(sd)) { const p = path.join(sd, s); if (fs.statSync(p).isDirectory() && fs.readdirSync(p).some(f => f.startsWith('step-') && f.endsWith('.lean'))) return true; }
    return false;
  }).sort();
}

/** Accumulate most-recent snapshot content per slug, up to targetIter. */
function resolveState(lp: string, targetIter: string): Map<string, { content: string; dn: string }> {
  const all = fs.readdirSync(lp).filter(d => d.startsWith('iter-') && d <= targetIter && fs.existsSync(path.join(lp, d, 'snapshots'))).sort();
  const best = new Map<string, { content: string; dn: string }>();
  for (const iter of all) {
    const sd = path.join(lp, iter, 'snapshots'); if (!fs.existsSync(sd)) continue;
    for (const slug of fs.readdirSync(sd)) {
      const slugDir = path.join(sd, slug); if (!fs.statSync(slugDir).isDirectory()) continue;
      const files = fs.readdirSync(slugDir).filter(f => f.endsWith('.lean')).sort();
      const latest = files[files.length - 1]; if (!latest) continue;
      try { best.set(slug, { content: fs.readFileSync(path.join(slugDir, latest), 'utf-8'), dn: slug.replace(/_/g, '/') + '.lean' }); } catch { /* */ }
    }
  }
  return best;
}

/** Build body map: declId -> body text, for a given accumulated state */
function bodyMap(state: Map<string, { content: string; dn: string }>): Map<string, string> {
  const m = new Map<string, string>();
  for (const [, { content, dn }] of state) {
    for (const d of parseContent(content, dn)) m.set(`${dn}::${d.name}`, d.body);
  }
  return m;
}

function buildTimeline(lp: string, pp: string) {
  const iters = snapIters(lp);
  let prevBodies = new Map<string, string>(); // bodies at the previous iteration

  return iters.map((iterDir, idx) => {
    let timestamp: string | undefined;
    try { const m = JSON.parse(fs.readFileSync(path.join(lp, iterDir, 'meta.json'), 'utf-8')); timestamp = m.completedAt || m.startedAt; } catch { /* */ }

    const state = resolveState(lp, iterDir);
    const perFile: Record<string, number> = {};
    const perDecl: Record<string, { hasSorry: boolean; sorryCount: number }> = {};
    let total = 0;
    for (const [, { content, dn }] of state) {
      const sc = countSorryInLean(content).length;
      perFile[dn] = sc; total += sc;
      for (const d of parseContent(content, dn)) perDecl[`${dn}::${d.name}`] = { hasSorry: d.hasSorry, sorryCount: d.sorryCount };
    }

    // Compute which declarations actually changed body from previous iteration
    const curBodies = bodyMap(state);
    const changed: string[] = [];
    for (const [id, body] of curBodies) {
      const prev = prevBodies.get(id);
      if (prev === undefined || prev !== body) changed.push(id);
    }
    prevBodies = curBodies;

    return { iteration: iterDir, timestamp, totalSorry: total, perFile, perDeclaration: perDecl, changedDeclarations: changed };
  });
}

function buildGraphAt(lp: string, pp: string, iteration: string) {
  const state = resolveState(lp, iteration);
  const allD: LD[] = []; const covered = new Set<string>();
  for (const [, { content, dn }] of state) { allD.push(...parseContent(content, dn)); covered.add(dn); }
  (function walk(dir: string) {
    try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (!['_lake','.lake','.archon','node_modules','.git'].includes(e.name)) walk(f); } else if (e.isFile() && e.name.endsWith('.lean')) { const rel = path.relative(pp, f); if (!covered.has(rel)) allD.push(...parseFile(f, rel)); } } } catch { /* */ }
  })(pp);
  const ed = edges(allD);
  const fg: Record<string, { file: string; declarations: string[] }> = {};
  for (const d of allD) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }
  return {
    declarations: allD.map(d => ({ id: `${d.file}::${d.name}`, kind: d.kind, name: d.name, file: d.file, line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature, totalAttempts: 0, latestMilestoneStatus: undefined, milestoneSessions: [] as string[], blocker: undefined })),
    edges: ed, files: Object.values(fg),
  };
}

function findDeclAt(lp: string, pp: string, iter: string, file: string, name: string): LD | undefined {
  const state = resolveState(lp, iter);
  const slug = file.replace(/\.lean$/, '').replace(/\//g, '_');
  const entry = state.get(slug);
  if (entry) { const d = parseContent(entry.content, file).find(d => d.name === name); if (d) return d; }
  return parseFile(path.join(pp, file), file).find(d => d.name === name);
}

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { projectPath: pp, archonPath: ap, logsPath: lp } = paths;

  fastify.get('/api/proofgraph/declarations', async () => {
    const allD: LD[] = [];
    (function walk(dir: string) { try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); if (e.isDirectory()) { if (!['_lake','.lake','.archon','node_modules','.git'].includes(e.name)) walk(f); } else if (e.isFile() && e.name.endsWith('.lean')) allD.push(...parseFile(f, path.relative(pp, f))); } } catch { /* */ } })(pp);
    const ed = edges(allD); const ms = getAllMilestones(ap);
    const fg: Record<string, { file: string; declarations: string[] }> = {};
    for (const d of allD) { if (!fg[d.file]) fg[d.file] = { file: d.file, declarations: [] }; fg[d.file].declarations.push(d.name); }
    return {
      declarations: allD.map(d => {
        const id = `${d.file}::${d.name}`; let mi = ms.get(id); if (!mi) { for (const [k, v] of ms) { if (k.split('::')[1] === d.name) { mi = v; break; } } }
        return { id, kind: d.kind, name: d.name, file: d.file, line: d.line, hasSorry: d.hasSorry, sorryCount: d.sorryCount, signature: d.signature, totalAttempts: mi?.totalAttempts ?? 0, latestMilestoneStatus: mi?.latestStatus, milestoneSessions: mi?.sessions ?? [], blocker: mi?.blocker };
      }), edges: ed, files: Object.values(fg),
    };
  });

  fastify.get('/api/proofgraph/timeline', async () => buildTimeline(lp, pp));

  fastify.get<{ Params: { iteration: string } }>('/api/proofgraph/snapshot/:iteration', async (req, reply) => {
    if (!req.params.iteration.startsWith('iter-')) return reply.status(400).send({ error: 'Invalid' });
    return buildGraphAt(lp, pp, req.params.iteration);
  });

  fastify.get<{ Params: { file: string; name: string }; Querystring: { iteration?: string } }>('/api/proofgraph/node/:file/:name', async (req) => {
    const file = decodeURIComponent(req.params.file), { name } = req.params, iter = req.query.iteration;
    const decl = iter ? findDeclAt(lp, pp, iter, file, name) : parseFile(path.join(pp, file), file).find(d => d.name === name);
    return {
      declaration: decl ? { id: `${decl.file}::${decl.name}`, kind: decl.kind, name: decl.name, file: decl.file, line: decl.line, endLine: decl.endLine, hasSorry: decl.hasSorry, sorryCount: decl.sorryCount, signature: decl.signature, body: decl.body } : null,
      milestones: getMilestonesForNode(ap, file, name, iter),
    };
  });
}