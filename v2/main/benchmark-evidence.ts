import { constants } from 'node:fs';
import { open, mkdir, realpath, stat } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { extname, join, relative, isAbsolute } from 'node:path';
import type { BenchmarkEvidence, BenchmarkRecord } from './benchmark-types';

const LIMIT = 1024 * 1024 * 1024;
const media: Record<string, string> = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const contained = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('../') && !isAbsolute(rel); };
export function validateEvidenceReceipt(e: BenchmarkEvidence) {
  if (!/^[a-f0-9-]{36}\.[a-z0-9]{1,10}$/.test(e.filename) || !/^[a-f0-9]{64}$/.test(e.sha256) || !Number.isSafeInteger(e.bytes) || e.bytes < 0 || e.bytes > LIMIT) throw new Error('Invalid evidence receipt.');
}
/** Streams regular files into a new exclusive destination and checks for concurrent changes. */
export async function copyBenchmarkEvidence(source: string, destination: string, limit = LIMIT) {
  const input = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let output: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const before = await input.stat();
    if (!before.isFile() || before.size > limit) throw new Error('Evidence must be a regular file within the size limit.');
    output = await open(destination, 'wx', 0o600);
    const hash = createHash('sha256'); let bytes = 0;
    const buffer = Buffer.alloc(64 * 1024);
    for (;;) {
      const read = await input.read(buffer, 0, buffer.length, null); if (!read.bytesRead) break;
      bytes += read.bytesRead; if (bytes > limit) throw new Error('Evidence changed beyond the size limit.');
      hash.update(buffer.subarray(0, read.bytesRead));
      let written = 0;
      while (written < read.bytesRead) { const part = await output.write(buffer, written, read.bytesRead - written); if (!part.bytesWritten) throw new Error('Could not copy evidence.'); written += part.bytesWritten; }
    }
    const after = await input.stat(), current = await stat(source);
    if (before.ino !== current.ino || before.dev !== current.dev || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size) throw new Error('Evidence changed while being copied; no receipt was created.');
    return { bytes, sha256: hash.digest('hex') };
  } finally { await output?.close(); await input.close(); }
}

export class BenchmarkEvidenceFiles {
  constructor(readonly directory: string) {}
  /** roots must come from the bound task or a native user picker, never renderer claims. */
  async capture(input: { path: string; kind: BenchmarkEvidence['kind']; label: string; origin: BenchmarkEvidence['origin']; videoStartOffsetMs?: number | null }, roots: string[]): Promise<BenchmarkEvidence> {
    if (!['video', 'image', 'artifact'].includes(input.kind) || !['engine-capture', 'user-selected'].includes(input.origin)) throw new Error('Invalid evidence provenance.');
    if (typeof input.label !== 'string' || !input.label.trim() || input.label.length > 200 || input.label.includes('\0')) throw new Error('Invalid evidence label.');
    const offset = input.videoStartOffsetMs ?? null;
    if (offset !== null && (!Number.isFinite(offset) || offset < 0 || offset > 86_400_000)) throw new Error('Invalid capture offset.');
    const source = await realpath(input.path), allowed = await Promise.all(roots.map(root => realpath(root)));
    if (!allowed.some(root => contained(root, source))) throw new Error('Evidence is outside the authorized task or selected folder.');
    const extension = extname(source).toLowerCase();
    if (input.kind !== 'artifact' && !media[extension]?.startsWith(input.kind + '/')) throw new Error('Unsupported media type.');
    const suffix = /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : '.bin';
    const id = randomUUID(), filename = id + suffix;
    await mkdir(this.directory, { recursive: true });
    const receipt = await copyBenchmarkEvidence(source, join(this.directory, filename));
    return { id, kind: input.kind, label: input.label, origin: input.origin, filename, ...receipt, addedAt: Date.now(), videoStartOffsetMs: input.kind === 'video' ? offset : null };
  }
  /** Exact receipt membership prevents arbitrary file reads via an evidence ID. */
  async preview(record: BenchmarkRecord, evidenceId: string): Promise<{ mimeType: string; dataUrl: string } | { unavailable: string }> {
    const evidence = record.variants.flatMap(v => v.evidence).find(e => e.id === evidenceId);
    if (!evidence) throw new Error('Benchmark evidence not found.');
    validateEvidenceReceipt(evidence);
    const mimeType = media[extname(evidence.filename)];
    if (!mimeType || evidence.kind === 'artifact') return { unavailable: 'This artifact has no inline media preview. Open the exported comparison.' };
    if (evidence.bytes > 32 * 1024 * 1024) return { unavailable: 'This media exceeds the inline preview limit. The exported comparison plays the original local file.' };
    const handle = await open(join(this.directory, evidence.filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile() || metadata.size !== evidence.bytes) throw new Error('Evidence size changed.');
      const buffer = Buffer.alloc(evidence.bytes + 1); let size = 0;
      while (size < buffer.length) { const result = await handle.read(buffer, size, buffer.length - size, null); if (!result.bytesRead) break; size += result.bytesRead; }
      const content = buffer.subarray(0, size);
      if (content.length !== evidence.bytes || createHash('sha256').update(content).digest('hex') !== evidence.sha256) throw new Error('Evidence digest changed.');
      return { mimeType, dataUrl: `data:${mimeType};base64,${content.toString('base64')}` };
    } finally { await handle.close(); }
  }
}
