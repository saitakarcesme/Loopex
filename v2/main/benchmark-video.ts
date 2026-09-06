import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { capture } from './providers/common';

interface RecorderOptions {
  directory: string;
  ffmpeg: string;
  /** Must capture only this variant's owned browser; return null when no tab exists. */
  captureFrame(taskId: string, turnId: string, signal: AbortSignal): Promise<string | null>;
  intervalMs?: number;
  maxFrames?: number;
  maxDurationMs?: number;
}
export interface BrowserRecordingResult { path?: string; startOffsetMs?: number; note: string; frameCount: number }
export interface BrowserRecordingSession { stop(): Promise<BrowserRecordingResult> }

/** Real sampled browser frames only; never screenshots of unrelated desktop apps. */
export class BenchmarkBrowserRecorder {
  readonly directory: string;
  constructor(private readonly options: RecorderOptions) {
    this.directory = options.directory;
    if ((options.intervalMs ?? 1000) < 250 || (options.maxFrames ?? 300) > 1200 || (options.maxFrames ?? 300) < 2 || (options.maxDurationMs ?? 300_000) < 500 || (options.maxDurationMs ?? 300_000) > 1_200_000) throw new Error('Invalid browser recording limits.');
  }
  async start(taskId: string, turnId: string): Promise<BrowserRecordingSession> {
    await mkdir(this.directory, { recursive: true });
    const directory = join(this.directory, randomUUID()); await mkdir(directory);
    const controller = new AbortController(), frames: Array<{ file: string; at: number }> = [];
    const origin = performance.now(); let stopped = false, failures = 0, total = 0, captureEndedAt = 0;
    const interval = this.options.intervalMs ?? 1000, max = this.options.maxFrames ?? 300;
    const loop = (async () => {
      while (!stopped && frames.length < max && performance.now() - origin < (this.options.maxDurationMs ?? 300_000)) {
        try {
          const image = await this.options.captureFrame(taskId, turnId, controller.signal);
          if (stopped) break;
          if (image) {
            const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(image);
            if (!match) throw new Error('Browser returned unsupported frame encoding.');
            if (match[2].length > 16 * 1024 * 1024) throw new Error('Browser frame exceeds the recording limit.');
            const content = Buffer.from(match[2], 'base64');
            total += content.length; if (total > 256 * 1024 * 1024) break;
            const file = `${String(frames.length).padStart(5, '0')}.${match[1] === 'png' ? 'png' : 'jpg'}`;
            const at = performance.now() - origin;
            await writeFile(join(directory, file), content, { flag: 'wx' }); frames.push({ file, at });
          }
        } catch { if (!stopped) failures++; }
        if (stopped) break;
        await new Promise<void>(resolve => {
          const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
          const timer = setTimeout(done, interval); controller.signal.addEventListener('abort', done, { once: true });
          if (controller.signal.aborted) done();
        });
      }
      captureEndedAt = performance.now() - origin;
    })();
    let result: Promise<BrowserRecordingResult> | undefined;
    return { stop: () => result ??= (async () => {
      stopped = true; controller.abort(); await loop;
      const stoppedAt = captureEndedAt;
      await writeFile(join(directory, 'frames.json'), JSON.stringify({ taskId, turnId, intervalMs: interval, frames, failedSamples: failures, stoppedAt }, null, 2));
      if (frames.length < 2) return { frameCount: frames.length, note: `Browser recording unavailable: only ${frames.length} actual frame(s) captured. No video was synthesized.` };
      const lines = frames.flatMap((frame, index) => [`file '${frame.file}'`, `duration ${Math.max(0.001, ((frames[index + 1]?.at ?? stoppedAt) - frame.at) / 1000).toFixed(6)}`]);
      lines.push(`file '${frames.at(-1)!.file}'`);
      const list = join(directory, 'frames.ffconcat'); await writeFile(list, 'ffconcat version 1.0\n' + lines.join('\n') + '\n');
      const path = join(directory, 'browser.mp4');
      try {
        await capture(this.options.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'concat', '-safe', '1', '-i', list, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-fps_mode', 'vfr', '-n', path], 60_000);
        return { path, startOffsetMs: frames[0].at, frameCount: frames.length, note: `Recorded ${frames.length} actual browser frames, sampled approximately every ${interval} ms; ${failures} sample(s) failed. This is sampled browser playback, not full desktop video or frame-accurate animation evidence.` };
      } catch (error) { return { frameCount: frames.length, note: `Actual frames retained, but video encoding failed: ${error instanceof Error ? error.message : String(error)}` }; }
    })() };
  }
}
