import { mkdir, readdir, lstat, realpath, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { copyBenchmarkEvidence } from './benchmark-evidence';
const ignored = new Set(['.git', 'node_modules', '.DS_Store']);
interface Entry { path: string; size: number; modified: number; inode: number; mode: number }
async function inventory(root: string) {
  const entries: Entry[] = [], excluded: string[] = [], directories: string[] = []; let total = 0;
  const walk = async (sub: string, depth: number) => {
    if (depth > 24) throw new Error('Benchmark fixture exceeds the directory depth limit.');
    for (const entry of (await readdir(join(root, sub), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = sub ? `${sub}/${entry.name}` : entry.name;
      if (ignored.has(entry.name) || /^\.env(?:\.|$)/i.test(entry.name) || /\.(pem|key)$/i.test(entry.name)) { excluded.push(path); continue; }
      const info = await lstat(join(root, path));
      if (info.isSymbolicLink()) throw new Error(`Benchmark fixture contains a symlink: ${path}. Supply a self-contained fixture.`);
      if (info.isDirectory()) { directories.push(path); if (directories.length > 5000) throw new Error('Benchmark fixture exceeds directory limit.'); await walk(path, depth + 1); continue; }
      if (!info.isFile() || info.size > 16 * 1024 * 1024 || entries.length >= 5000) throw new Error(`Unsupported benchmark fixture file: ${path}`);
      total += info.size; if (total > 128 * 1024 * 1024) throw new Error('Benchmark fixture exceeds 128 MiB.');
      entries.push({ path, size: info.size, modified: info.mtimeMs, inode: info.ino, mode: info.mode & 0o777 });
    }
  };
  await walk('', 0); return { entries, excluded, directories };
}
/** Freeze one baseline, then fork all variants from those captured bytes, not live source. */
export async function snapshotBenchmarkWorkspace(source: string | null, destination: string): Promise<{ digest: string; excluded: string[] }> {
  await mkdir(destination);
  if (!source) return { digest: createHash('sha256').update(JSON.stringify({ files: [], directories: [] })).digest('hex'), excluded: [] };
  const root = await realpath(source), before = await inventory(root), receipts: Array<{ path: string; sha256: string; mode: number }> = [];
  for (const directory of before.directories) await mkdir(join(destination, directory), { recursive: true });
  for (const entry of before.entries) {
    const target = join(destination, entry.path);
    await mkdir(join(target, '..'), { recursive: true });
    const result = await copyBenchmarkEvidence(join(root, entry.path), target, 16 * 1024 * 1024);
    await chmod(target, entry.mode);
    receipts.push({ path: entry.path, sha256: result.sha256, mode: entry.mode });
  }
  const after = await inventory(root);
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Benchmark fixture changed during snapshot. No variants were started.');
  return { digest: createHash('sha256').update(JSON.stringify({ files: receipts, directories: before.directories })).digest('hex'), excluded: before.excluded };
}
