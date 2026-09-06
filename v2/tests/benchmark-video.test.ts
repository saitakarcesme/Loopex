import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BenchmarkBrowserRecorder } from '../main/benchmark-video';
import { capture } from '../main/providers/common';

test('recorder emits no video when no actual browser frames exist', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-no-video-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recorder = new BenchmarkBrowserRecorder({ directory, ffmpeg: '/no-encoder-needed', captureFrame: async () => null });
  const session = await recorder.start('task', 'turn'); const result = await session.stop();
  assert.equal(result.path, undefined); assert.equal(result.frameCount, 0); assert.match(result.note, /No video was synthesized/);
  assert.deepEqual(await session.stop(), result);
});
test('recorder encodes and decodes a real MP4 from controlled test frames with measured timestamps', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'benchmark-video-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  // Synthetic test fixture only, not claimed as application capture evidence.
  const png = join(directory, 'test-frame.png');
  await capture('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=32x32', '-frames:v', '1', png], 10_000);
  const frame = `data:image/png;base64,${(await readFile(png)).toString('base64')}`;
  let count = 0; const seen: string[] = [];
  const recorder = new BenchmarkBrowserRecorder({ directory, ffmpeg: '/opt/homebrew/bin/ffmpeg', intervalMs: 250, maxFrames: 2, captureFrame: async (task, turn) => { seen.push(`${task}/${turn}`); count++; return frame; } });
  const session = await recorder.start('owned-task', 'owned-turn');
  while (count < 2) await new Promise(resolve => setTimeout(resolve, 20));
  await new Promise(resolve => setTimeout(resolve, 30));
  const result = await session.stop(); assert.ok(result.path, result.note); assert.equal(result.frameCount, 2);
  assert.match(result.note, /actual browser frames/); assert.match(result.note, /not full desktop/);
  assert.deepEqual(seen, ['owned-task/owned-turn', 'owned-task/owned-turn']);
  const encoded = await readFile(result.path); assert.equal(encoded.subarray(4, 8).toString(), 'ftyp');
  await capture('/opt/homebrew/bin/ffmpeg', ['-nostdin', '-v', 'error', '-i', result.path, '-f', 'null', '-'], 10_000);
});
