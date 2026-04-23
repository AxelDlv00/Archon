/** Git log API — exposes the inner archon git repo (.archon/git-dir) to the UI */
import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import type { FastifyInstance } from 'fastify';
import type { ProjectPaths } from './project.js';

export interface GitCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
  parents: string[];
  refs: string[];
  branch?: string;
  iteration?: string;
  phase?: string;
  fileSlug?: string;
}

function runGit(gitDir: string, projectPath: string, args: string[]): string {
  const r = spawnSync('git', args, {
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: projectPath },
    cwd: projectPath,
    encoding: 'utf-8',
    timeout: 8000,
  });
  return r.status === 0 ? (r.stdout ?? '') : '';
}

const ARCHON_MSG_RE = /archon\[(\d+)\/([^/\]]+)(?:\/([^\]]+))?\]/;

function parseIter(subject: string): { iteration?: string; phase?: string; fileSlug?: string } {
  const m = subject.match(ARCHON_MSG_RE);
  if (!m) return {};
  const num = parseInt(m[1], 10);
  return {
    iteration: `iter-${String(num).padStart(3, '0')}`,
    phase: m[2],
    fileSlug: m[3] as string | undefined,
  };
}

const LOG_EVENTS = new Set(['thinking', 'text', 'tool_call', 'tool_result', 'session_end']);

function readPhaseLog(logsPath: string, iteration: string, phase: string): unknown[] {
  const logFile = path.join(logsPath, iteration, `${phase}.jsonl`);
  if (!fs.existsSync(logFile)) return [];
  const entries: unknown[] = [];
  try {
    for (const line of fs.readFileSync(logFile, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (!LOG_EVENTS.has(e.event)) continue;
        if (e.event === 'thinking' && typeof e.content === 'string' && e.content.length > 3000)
          e.content = e.content.slice(0, 3000) + '\n... [truncated]';
        entries.push(e);
      } catch { /* skip malformed */ }
    }
  } catch { /* file not readable */ }
  return entries;
}

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { projectPath, archonPath, logsPath } = paths;
  const gitDir = path.join(archonPath, 'git-dir');

  /** Full commit log from the inner archon git repo */
  fastify.get('/api/git/log', async (_, reply) => {
    if (!fs.existsSync(gitDir)) return reply.status(404).send({ commits: [] });

    // %x01 = field separator (SOH), %x02 = record separator (STX)
    const raw = runGit(gitDir, projectPath, [
      'log', '--all', '--topo-order',
      '--format=%H%x01%h%x01%s%x01%ai%x01%P%x01%D%x02',
    ]);
    if (!raw.trim()) return { commits: [] };

    const commits: GitCommit[] = [];
    for (const record of raw.split('\x02')) {
      const trimmed = record.trim();
      if (!trimmed) continue;
      const parts = trimmed.split('\x01');
      if (parts.length < 6) continue;
      const [sha, shortSha, subject, date, parentsRaw, refsRaw] = parts;
      const parents = parentsRaw?.trim() ? parentsRaw.trim().split(' ').filter(Boolean) : [];
      const refs = refsRaw?.trim()
        ? refsRaw.split(',').map(r => r.trim()).filter(Boolean)
        : [];
      const { iteration, phase, fileSlug } = parseIter(subject ?? '');
      commits.push({ sha, shortSha, subject: subject ?? '', date, parents, refs, iteration, phase, fileSlug });
    }

    // Assign a primary branch to each commit from its ref decorations
    const branchAt = new Map<string, string>();
    for (const c of commits) {
      for (const ref of c.refs) {
        // Refs look like: "HEAD -> main", "main", "origin/main", "tag: v1.0"
        const clean = ref.replace(/^HEAD -> /, '').trim();
        if (!clean.startsWith('tag:') && !clean.startsWith('origin/') && !branchAt.has(c.sha)) {
          branchAt.set(c.sha, clean);
        }
      }
    }

    // Propagate branch from parent to children.
    // --topo-order without --reverse = newest first, so parents are at higher indices.
    // Walking from high to low indices processes parents before children.
    for (let i = commits.length - 1; i >= 0; i--) {
      const c = commits[i];
      if (!branchAt.has(c.sha)) {
        for (const p of c.parents) {
          const pb = branchAt.get(p);
          if (pb) { branchAt.set(c.sha, pb); break; }
        }
      }
    }

    for (const c of commits) c.branch = branchAt.get(c.sha) ?? 'main';

    return { commits };
  });

  /** Phase logs for non-prover phases (plan, refactor, review, finalize) */
  fastify.get<{ Params: { iteration: string; phase: string } }>(
    '/api/git/phase-logs/:iteration/:phase',
    async (req, reply) => {
      const { iteration, phase } = req.params;
      if (!iteration.startsWith('iter-')) return reply.status(400).send({ error: 'Invalid iteration' });
      const entries = readPhaseLog(logsPath, iteration, phase);
      return { entries };
    }
  );

  /** Blueprint LaTeX block for a declaration (from blueprint/src/chapters/{slug}.tex) */
  fastify.get<{ Querystring: { file?: string; name?: string } }>(
    '/api/blueprint',
    async (req, reply) => {
      const { file, name } = req.query;
      if (!file || !name) return reply.status(400).send({ error: 'Missing file or name' });
      const slug = file.replace(/\.lean$/, '').replace(/\//g, '_');
      const texFile = path.join(projectPath, 'blueprint', 'src', 'chapters', `${slug}.tex`);
      if (!fs.existsSync(texFile)) return { tex: null };
      const content = fs.readFileSync(texFile, 'utf-8');
      // Find the LaTeX block containing \lean{name}
      const idx = content.indexOf(`\\lean{${name}}`);
      if (idx < 0) return { tex: null };
      // Find the nearest enclosing environment before this position
      const envRe = /\\begin\{(theorem|lemma|definition|remark|proposition|corollary)\}/g;
      let bestStart = -1;
      let m: RegExpExecArray | null;
      while ((m = envRe.exec(content)) !== null) {
        if (m.index <= idx) bestStart = m.index;
      }
      if (bestStart < 0) return { tex: null };
      const envName = content.slice(bestStart).match(/\\begin\{(\w+)\}/)?.[1] ?? 'theorem';
      const endTag = `\\end{${envName}}`;
      const endIdx = content.indexOf(endTag, bestStart);
      if (endIdx < 0) return { tex: null };
      return { tex: content.slice(bestStart, endIdx + endTag.length) };
    }
  );
}
