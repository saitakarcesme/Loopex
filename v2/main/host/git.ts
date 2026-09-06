import path from 'node:path'
import { realpath } from 'node:fs/promises'
import type { GitStatus, HostContext } from '../../shared/contracts'
import { containedPath, writable } from './files'
import { runCommand } from './process'

async function git(context: HostContext, args: string[], accept = [0]): Promise<string> {
  const result = await runCommand('git', ['-c', 'core.quotePath=false', ...args], { cwd: context.cwd, timeout: 15_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } })
  if (!accept.includes(result.code)) throw new Error(result.stderr.trim() || `Git exited with code ${result.code}.`)
  if (result.truncated && !args.includes('diff')) throw new Error('Git output exceeded 1 MB. Narrow the selected project before retrying.')
  return result.stdout + (result.truncated ? '\n[Git output truncated at 1 MB]\n' : '')
}
async function relativePath(context: HostContext, input: string): Promise<string> {
  const target = await containedPath(context.cwd, input, true)
  return path.relative(await realpath(context.cwd), target)
}
export async function gitStatus(context: HostContext): Promise<GitStatus> {
  const repository = await runCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: context.cwd, timeout: 5000 })
  if (repository.code !== 0 || repository.stdout.trim() !== 'true') return { isRepo: false, branch: '', files: [] }
  const [branch, porcelain, prefix] = await Promise.all([
    git(context, ['symbolic-ref', '--short', '-q', 'HEAD'], [0, 1]).then(value => value.trim() || 'Detached HEAD'),
    git(context, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.']),
    git(context, ['rev-parse', '--show-prefix']).then(value => value.trim())
  ])
  const records = porcelain.split('\0'); const files: GitStatus['files'] = []
  for (let index = 0; index < records.length; index++) {
    const record = records[index]; if (!record) continue
    const status = record.slice(0, 2); const filePath = record.slice(3)
    if (!prefix || filePath.startsWith(prefix)) files.push({ path: prefix ? filePath.slice(prefix.length) : filePath, status })
    if (/[RC]/.test(status)) index++ // Porcelain -z emits destination then original path for renames/copies.
  }
  return { isRepo: true, branch, files }
}
export async function gitDiff(context: HostContext, input?: string): Promise<{ diff: string }> {
  const target = input ? await relativePath(context, input) : '.'
  const [unstaged, staged] = await Promise.all([
    git(context, ['diff', '--no-ext-diff', '--no-textconv', '--', target]),
    git(context, ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--', target])
  ])
  let untracked = ''
  const status = await gitStatus(context)
  const candidates = status.files.filter(file => file.status === '??' && (!input || file.path === target)).slice(0, 30)
  for (const file of candidates) {
    const safe = await relativePath(context, file.path)
    untracked += await git(context, ['diff', '--no-index', '--no-ext-diff', '--no-textconv', '--', '/dev/null', safe], [0, 1])
    if (untracked.length > 512 * 1024) { untracked = `${untracked.slice(0, 512 * 1024)}\n[Diff truncated]\n`; break }
  }
  return { diff: `${staged ? `# Staged changes\n${staged}\n` : ''}${unstaged}${untracked}`.slice(0, 2 * 1024 * 1024) }
}
export async function gitStage(context: HostContext, input: string, staged: boolean): Promise<{ ok: true }> {
  writable(context)
  const target = await relativePath(context, input)
  if (!target || target === '.') throw new Error('Select a specific file to stage.')
  if (staged) await git(context, ['add', '--', target])
  else {
    const head = await runCommand('git', ['rev-parse', '--verify', 'HEAD'], { cwd: context.cwd, timeout: 5000 })
    await git(context, head.code === 0 ? ['reset', '-q', 'HEAD', '--', target] : ['rm', '--cached', '-q', '--', target])
  }
  return { ok: true }
}
