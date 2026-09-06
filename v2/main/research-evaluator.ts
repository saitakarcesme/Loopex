import { isAbsolute } from 'node:path';
import { containedPath } from './host/files';
import { StringDecoder } from 'node:string_decoder';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { spawnOwnedProcess, type OwnedProcess } from './providers/process-owner';
import { findExecutable, providerEnv } from './providers/common';
import type { ResearchMeasurement, ResearchStudy } from './research-types';
export class ResearchEvaluatorRunner {
    private owners = new Set<OwnedProcess>();
    get hasOwnedProcesses() { return this.owners.size > 0; }
    async measure(study: ResearchStudy, cwd: string, signal: AbortSignal): Promise<ResearchMeasurement> {
        signal.throwIfAborted();
        const command = study.evaluator.command;
        const executable = await findExecutable(!isAbsolute(command) && command.includes('/') ? await containedPath(cwd, command) : command);
        signal.throwIfAborted();
        const startedAt = Date.now(), start = performance.now();
        const owner = spawnOwnedProcess(executable, study.evaluator.args, { cwd, env: providerEnv(), shell: false });
        this.owners.add(owner);
        let stdout = '', stderr = '', bytes = 0, overflow = false, timedOut = false, spawnError: string | undefined;
        const stdoutDecoder = new StringDecoder('utf8'), stderrDecoder = new StringDecoder('utf8'), stdoutHash = createHash('sha256');
        const child = owner.child;
        let rejectCompletion!: (error: unknown) => void;
        const completion = new Promise<number | null>((resolve, reject) => { rejectCompletion = reject; child.once('error', error => { spawnError = error.message; resolve(null); }); child.once('close', code => resolve(code)); });
        const stop = () => { void owner.stop().catch(rejectCompletion); };
        const capture = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
                overflow = true;
                stop();
                return;
            }
            if (stream === 'stdout') {
                stdoutHash.update(chunk);
                stdout += stdoutDecoder.write(chunk);
            }
            else
                stderr += stderrDecoder.write(chunk);
        };
        child.stdout.on('data', chunk => capture('stdout', chunk));
        child.stderr.on('data', chunk => capture('stderr', chunk));
        child.stdin.end();
        const timer = setTimeout(() => { timedOut = true; stop(); }, study.evaluator.timeoutMs);
        signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted)
            stop();
        try {
            const exitCode = await completion;
            await owner.stop();
            this.owners.delete(owner);
            stdout += stdoutDecoder.end();
            stderr += stderrDecoder.end();
            let value: number | null = null, error = spawnError;
            if (signal.aborted)
                error = 'Experiment cancelled.';
            else if (timedOut)
                error = 'Evaluator exceeded its timeout.';
            else if (overflow)
                error = 'Evaluator output exceeded 1 MiB.';
            else if (exitCode !== 0)
                error = `Evaluator exited ${exitCode}.`;
            else
                try {
                    const line = stdout.trim().split('\n').at(-1) || '';
                    const payload = JSON.parse(line);
                    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || typeof payload[study.metric] !== 'number' || !Number.isFinite(payload[study.metric]))
                        throw new Error('missing metric');
                    value = payload[study.metric];
                }
                catch {
                    error = `The final stdout line must be a JSON object containing finite numeric metric "${study.metric}".`;
                }
            return { source: 'host-evaluator', command: executable, args: [...study.evaluator.args], cwd, startedAt, durationMs: performance.now() - start, exitCode, stdout, stderr, stdoutSha256: stdoutHash.digest('hex'), value, timedOut, cancelled: signal.aborted, error, protocolHash: study.protocolHash };
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', stop);
        }
    }
    async dispose(): Promise<void> {
        const results = await Promise.allSettled([...this.owners].map(async (owner) => { await owner.stop(); this.owners.delete(owner); }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
    }
}
