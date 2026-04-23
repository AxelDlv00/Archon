/**
 * Helpers for interacting with the inner archon git repo (.archon/git-dir).
 *
 * All helpers are no-ops when the inner git doesn't exist, so callers can use
 * them unconditionally on legacy projects without checking for the directory
 * first.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';

export interface InnerCommit {
  sha: string;
  shortSha: string;
  subject: string;
  date: string;
}

function run(gitDir: string, projectPath: string, args: string[]): { stdout: string; ok: boolean } {
  const r = spawnSync('git', args, {
    env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: projectPath },
    cwd: projectPath,
    encoding: 'utf-8',
    timeout: 8000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: r.stdout ?? '', ok: r.status === 0 };
}

/** True when the inner archon git exists. */
export function hasInnerGit(gitDir: string): boolean {
  return fs.existsSync(gitDir);
}

/**
 * Map iteration id (iter-NNN) → latest commit on that iteration.
 * "Latest" = newest in topo-order that mentions `archon[NNN/...]` in its subject.
 */
export function mapIterToCommit(gitDir: string, projectPath: string): Map<string, InnerCommit> {
  const out = new Map<string, InnerCommit>();
  if (!hasInnerGit(gitDir)) return out;
  const { stdout, ok } = run(gitDir, projectPath, [
    'log', '--all', '--topo-order',
    '--format=%H%x01%h%x01%s%x01%ai',
  ]);
  if (!ok) return out;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const [sha, shortSha, subject, date] = line.split('\x01');
    const m = subject?.match(/archon\[(\d+)\//);
    if (!m) continue;
    const iterId = `iter-${String(parseInt(m[1], 10)).padStart(3, '0')}`;
    if (!out.has(iterId)) out.set(iterId, { sha, shortSha, subject, date });
  }
  return out;
}

/** List all .lean files in the tree at a given commit. */
export function lsLeanFilesAtCommit(gitDir: string, projectPath: string, sha: string): string[] {
  if (!hasInnerGit(gitDir)) return [];
  const { stdout, ok } = run(gitDir, projectPath, ['ls-tree', '-r', '--name-only', sha]);
  if (!ok) return [];
  return stdout.split('\n').filter(f => f.endsWith('.lean'));
}

/**
 * Read file content at a given commit. Returns null when the file didn't
 * exist at that commit (git show exits non-zero).
 */
export function showFileAtCommit(
  gitDir: string,
  projectPath: string,
  sha: string,
  file: string,
): string | null {
  if (!hasInnerGit(gitDir)) return null;
  const { stdout, ok } = run(gitDir, projectPath, ['show', `${sha}:${file}`]);
  return ok ? stdout : null;
}
