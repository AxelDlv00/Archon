/** Logs API — tree listing, content retrieval, WebSocket streaming */
import fs from 'fs';
import path from 'path';
import type { FastifyInstance } from 'fastify';
import { parseJsonl, readFileOr } from '../utils.js';
import type { ProjectPaths } from './project.js';

interface LogFileEntry { name: string; path: string; size: number; modified: string; role?: string }
interface LogGroup { id: string; files: LogFileEntry[]; meta?: Record<string, unknown> }

function resolveLogPath(logsPath: string, logPath: string): string | null {
  const normalized = path.normalize(logPath).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(logsPath, normalized);
  if (!full.startsWith(logsPath)) return null;
  // For .md files, pass through as-is; for others, default to .jsonl
  if (full.endsWith('.md') || full.endsWith('.jsonl')) return full;
  return full + '.jsonl';
}

export function register(fastify: FastifyInstance, paths: ProjectPaths) {
  const { logsPath } = paths;

  // Tree-structured log listing
  fastify.get('/api/logs', async () => {
    if (!fs.existsSync(logsPath)) return { flat: [], groups: [] };

    const flat: LogFileEntry[] = fs.readdirSync(logsPath)
      .filter(f => f.endsWith('.jsonl') && fs.statSync(path.join(logsPath, f)).isFile())
      .map(f => {
        const stat = fs.statSync(path.join(logsPath, f));
        return { name: f, path: f, size: stat.size, modified: stat.mtime.toISOString() };
      })
      .sort((a, b) => b.modified.localeCompare(a.modified));

    const groups: LogGroup[] = [];
    const iterDirs = fs.readdirSync(logsPath)
      .filter(d => d.startsWith('iter-') && fs.statSync(path.join(logsPath, d)).isDirectory())
      .sort();

    for (const dir of iterDirs) {
      const dirPath = path.join(logsPath, dir);
      const files: LogFileEntry[] = [];

      // Standard JSONL logs at the iteration root.
      for (const f of fs.readdirSync(dirPath).filter(f => f.endsWith('.jsonl') && !f.endsWith('.raw.jsonl') && f !== 'provers-combined.jsonl')) {
        const full = path.join(dirPath, f);
        if (!fs.statSync(full).isFile()) continue;
        const role = f.replace('.jsonl', '');
        const stat = fs.statSync(full);
        files.push({ name: f, path: `${dir}/${f}`, size: stat.size, modified: stat.mtime.toISOString(), role });
      }

      // Refactor artifacts (archived markdown).
      for (const artifact of ['refactor-directive.md', 'refactor-report.md']) {
        const full = path.join(dirPath, artifact);
        if (!fs.existsSync(full) || !fs.statSync(full).isFile()) continue;
        const stat = fs.statSync(full);
        files.push({
          name: artifact,
          path: `${dir}/${artifact}`,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          role: artifact.replace('.md', ''),  // "refactor-directive" | "refactor-report"
        });
      }

      // Parallel prover JSONL logs.
      const proversDir = path.join(dirPath, 'provers');
      if (fs.existsSync(proversDir) && fs.statSync(proversDir).isDirectory()) {
        for (const f of fs.readdirSync(proversDir).filter(f => f.endsWith('.jsonl') && !f.endsWith('.raw.jsonl')).sort()) {
          const full = path.join(proversDir, f);
          const stat = fs.statSync(full);
          files.push({ name: f, path: `${dir}/provers/${f}`, size: stat.size, modified: stat.mtime.toISOString(), role: 'prover' });
        }
      }

      let meta: Record<string, unknown> | undefined;
      const metaFile = path.join(dirPath, 'meta.json');
      try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8')); } catch { /* skip */ }

      groups.push({ id: dir, files, meta });
    }

    return { flat, groups };
  });

  // Wildcard log content — supports both .jsonl (parsed) and .md (raw).
  fastify.get('/api/logs/*', async (req, reply) => {
    const subpath = (req.params as Record<string, string>)['*'];
    if (!subpath) return reply.status(400).send({ error: 'Missing path' });
    const filePath = resolveLogPath(logsPath, subpath);
    if (!filePath || !fs.existsSync(filePath)) return reply.status(404).send({ error: 'Not found' });

    if (filePath.endsWith('.md')) {
      // Serve markdown as a single synthetic "text" log entry so the existing
      // client log-viewer can render it without a separate code path.
      const content = readFileOr(filePath, '');
      const stat = fs.statSync(filePath);
      return [{
        ts: stat.mtime.toISOString(),
        event: 'text',
        content,
      }];
    }

    return parseJsonl(filePath);
  });

  // WebSocket streaming (JSONL only; .md files are static artifacts).
  fastify.get('/api/log-stream/*', { websocket: true }, (socket, req) => {
    const subpath = (req.params as Record<string, string>)['*'] || '';
    const filePath = resolveLogPath(logsPath, subpath);
    if (!filePath || !fs.existsSync(filePath) || !filePath.endsWith('.jsonl')) {
      socket.send(JSON.stringify({ type: 'error', message: 'Not found or not streamable' }));
      socket.close();
      return;
    }

    let lastSize = fs.statSync(filePath).size;
    socket.send(JSON.stringify({ type: 'ready', size: lastSize }));

    const watcher = fs.watch(filePath, () => {
      try {
        const newSize = fs.statSync(filePath).size;
        if (newSize <= lastSize) return;
        const stream = fs.createReadStream(filePath, { start: lastSize, end: newSize - 1, encoding: 'utf-8' });
        let buffer = '';
        stream.on('data', (chunk) => {
          buffer += chunk;
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          for (const line of lines) {
            if (line.trim()) try { socket.send(line); } catch { /* ignore */ }
          }
        });
        stream.on('end', () => {
          if (buffer.trim()) try { socket.send(buffer); } catch { /* ignore */ }
        });
        lastSize = newSize;
      } catch { /* ignore stat errors during write */ }
    });

    socket.on('close', () => watcher.close());
  });
}