import { realpath, mkdir, readFile, stat } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnOwnedProcess, type OwnedProcess } from './providers/process-owner';
import { providerEnv } from './providers/common';
import { containedPath } from './host/files';
import type { ResearchEvaluator } from './research-types';
function sensitivePath(path: string): boolean {
    return path.split('/').some(part => /^\.env(?:\.|$)|^id_(rsa|dsa|ecdsa|ed25519)$|^\.ssh$|(^|[-_.])(credentials?|secrets?|passwords?)([-_.]|$)|\.(pem|key|p12|pfx|sqlite|db)$/i.test(part));
}
export class ResearchWorkspaces {
    private owners = new Set<OwnedProcess>();
    get hasOwnedProcesses() { return this.owners.size > 0; }
    constructor(private userData: string) { }
    async git(cwd: string, args: string[], signal?: AbortSignal): Promise<string> {
        signal?.throwIfAborted();
        const owner = spawnOwnedProcess('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd, env: providerEnv(), shell: false });
        this.owners.add(owner);
        let output = '', error = '', size = 0, limited = false, timedOut = false;
        const child = owner.child;
        let rejectCompletion!: (error: unknown) => void;
        const completion = new Promise<number | null>((resolve, reject) => { rejectCompletion = reject; child.once('error', reject); child.once('close', resolve); });
        const stop = () => { void owner.stop().catch(rejectCompletion); };
        const collect = (data: Buffer, stderr = false) => { size += data.length; if (size > 2 * 1024 * 1024) {
            limited = true;
            stop();
            return;
        } if (stderr)
            error += data;
        else
            output += data; };
        child.stdout.on('data', d => collect(d));
        child.stderr.on('data', d => collect(d, true));
        child.stdin.end();
        const timer = setTimeout(() => { timedOut = true; stop(); }, 30000);
        signal?.addEventListener('abort', stop, { once: true });
        if (signal?.aborted)
            stop();
        try {
            const code = await completion;
            await owner.stop();
            this.owners.delete(owner);
            signal?.throwIfAborted();
            if (limited || timedOut)
                throw new Error('Research Git operation exceeded its output or time limit.');
            if (code !== 0)
                throw new Error(`Research Git operation failed: ${error.slice(-2000)}`);
            return output;
        }
        finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', stop);
            if (this.owners.has(owner)) {
                await owner.stop();
                this.owners.delete(owner);
            }
        }
    }
    async verifyProject(root: string): Promise<string> {
        const canonical = await realpath(root);
        if (await realpath((await this.git(canonical, ['rev-parse', '--show-toplevel'])).trim()) !== canonical)
            throw new Error('Select the Git repository root for research.');
        const head = (await this.git(canonical, ['rev-parse', '--verify', 'HEAD'])).trim();
        const tracked = (await this.git(canonical, ['ls-files', '-z'])).split('\0').filter(Boolean);
        if (tracked.some(sensitivePath))
            throw new Error('Research cannot isolate a project that tracks credential or runtime database files.');
        if ((await this.git(canonical, ['status', '--porcelain', '--untracked-files=normal'])).trim())
            throw new Error('Research needs a clean Git project. Commit or preserve current changes first.');
        return head;
    }
    async create(root: string, id: string, baseCwd: string | undefined, signal: AbortSignal, initialCommit?: string): Promise<string> {
        if (!/^[a-f0-9-]{36}$/.test(id))
            throw new Error('Invalid experiment identifier.');
        const head = initialCommit ?? (baseCwd ? (await this.git(baseCwd, ['rev-parse', 'HEAD'], signal)).trim() : await this.verifyProject(root));
        signal.throwIfAborted();
        const parent = join(this.userData, 'research-workspaces');
        await mkdir(parent, { recursive: true });
        const path = join(parent, id);
        await this.git(root, ['worktree', 'add', '--detach', path, head], signal);
        return realpath(path);
    }
    async protectEvaluator(root: string, evaluator: ResearchEvaluator): Promise<Record<string, string>> {
        const candidates = [...(!isAbsolute(evaluator.command) && evaluator.command.includes('/') ? [evaluator.command] : []), ...(evaluator.args[0] && !evaluator.args[0].startsWith('-') ? [evaluator.args[0]] : []), ...(evaluator.protectedPaths ?? [])];
        const hashes: Record<string, string> = {};
        for (const file of candidates) {
            if (sensitivePath(file))
                throw new Error('Credential files cannot be evaluator dependencies.');
            if (isAbsolute(file))
                throw new Error('Evaluator scripts must be inside the project; use a project-relative script path.');
            const path = await containedPath(root, file);
            const info = await stat(path);
            if (!info.isFile() || info.size > 1024 * 1024)
                throw new Error('Evaluator script must be a file no larger than 1 MiB.');
            hashes[relative(await realpath(root), path)] = createHash('sha256').update(await readFile(path)).digest('hex');
        }
        return hashes;
    }
    async verifyEvaluator(cwd: string, hashes: Record<string, string>): Promise<void> {
        for (const [file, expected] of Object.entries(hashes)) {
            const path = await containedPath(cwd, file), info = await stat(path);
            if (!info.isFile() || info.size > 1024 * 1024 || createHash('sha256').update(await readFile(path)).digest('hex') !== expected)
                throw new Error(`Evaluator protocol changed: ${file}. Create a new study for a different benchmark.`);
        }
    }
    async checkpoint(cwd: string, signal: AbortSignal): Promise<void> {
        const changed = (await this.git(cwd, ['diff', '--name-only', '-z', 'HEAD'], signal)).split('\0').filter(Boolean);
        const added = (await this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
        const paths = [...new Set([...changed, ...added])];
        if (paths.some(sensitivePath))
            throw new Error('Experiment contains potentially sensitive or runtime files; these were not committed.');
        if (!paths.length)
            return;
        await this.git(cwd, ['add', '--', ...paths], signal);
        await this.git(cwd, ['-c', 'user.name=Akorith Research', '-c', 'user.email=research@localhost', '-c', 'commit.gpgsign=false', 'commit', '--no-verify', '-m', 'Record isolated research experiment'], signal);
    }
    async dispose(): Promise<void> {
        const results = await Promise.allSettled([...this.owners].map(async (owner) => { await owner.stop(); this.owners.delete(owner); }));
        const failed = results.find(result => result.status === 'rejected');
        if (failed?.status === 'rejected')
            throw failed.reason;
    }
}
