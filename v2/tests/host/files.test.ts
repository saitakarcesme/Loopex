import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { containedPath, listFiles, readFile, readMedia, writeFile, searchFiles, sha256 } from '../../main/host/files'
import { gitDiff, gitStage, gitStatus } from '../../main/host/git'
import { runCommand } from '../../main/host/process'
import type { HostContext } from '../../shared/contracts'

async function fixture(): Promise<{ base: string; context: HostContext; cleanup(): Promise<void> }> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-host-test-'))
  const cwd = path.join(base, 'project'); await fs.mkdir(cwd)
  return { base, context: { cwd, taskId: 'test-task', mode: 'work' }, cleanup: () => fs.rm(base, { recursive: true, force: true }) }
}

test('workspace containment blocks traversal and external symlinks for existing and new paths', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.base, 'outside.txt'), 'outside')
    await fs.symlink(f.base, path.join(f.context.cwd, 'escape'))
    for (const name of ['../outside.txt', path.join(f.base, 'outside.txt'), 'escape/outside.txt', 'escape/new/sub/file.txt']) {
      await assert.rejects(containedPath(f.context.cwd, name, true), /outside/)
      await assert.rejects(writeFile(f.context, name, 'changed'), /outside/)
    }
    assert.equal(await fs.readFile(path.join(f.base, 'outside.txt'), 'utf8'), 'outside')
    assert.deepEqual(await listFiles(f.context), [])
  } finally { await f.cleanup() }
})

test('safe writes preserve concurrent changes, file mode and valid internal symlinks', async () => {
  const f = await fixture()
  try {
    await writeFile(f.context, 'nested/app.txt', 'first')
    await fs.chmod(path.join(f.context.cwd, 'nested/app.txt'), 0o600)
    const first = await readFile(f.context, 'nested/app.txt')
    assert.equal(first.hash, sha256('first'))
    await writeFile(f.context, 'nested/app.txt', 'second', first.hash)
    assert.equal((await fs.stat(path.join(f.context.cwd, 'nested/app.txt'))).mode & 0o777, 0o600)
    await assert.rejects(writeFile(f.context, 'nested/app.txt', 'stale', first.hash), /changed on disk/)
    await fs.symlink('nested/app.txt', path.join(f.context.cwd, 'alias.txt'))
    assert.equal((await readFile(f.context, 'alias.txt')).content, 'second')
    await assert.rejects(writeFile({ ...f.context, mode: 'read' }, 'nested/app.txt', 'no'), /Inspect mode/)
    assert.equal((await readFile(f.context, 'nested/app.txt')).content, 'second')
    await assert.rejects(writeFile(f.context, '.git/config', 'no'), /metadata/)
  } finally { await f.cleanup() }
})

test('bounded reads report binary and truncation; search skips dependencies and follows no loops', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.context.cwd, 'binary.dat'), Buffer.from([0, 1, 2]))
    assert.equal((await readFile(f.context, 'binary.dat')).binary, true)
    await writeFile(f.context, 'source.txt', 'alpha\nneedle here\nend')
    assert.equal((await readFile(f.context, 'source.txt', 5)).truncated, true)
    await writeFile(f.context, 'node_modules/hidden.txt', 'needle')
    await fs.symlink('.', path.join(f.context.cwd, 'loop'))
    assert.deepEqual((await searchFiles(f.context, 'needle')).results, [{ path: 'source.txt', line: 2, text: 'needle here' }])
    await assert.rejects(readFile(f.context, '.'), /regular file/)
  } finally { await f.cleanup() }
})

test('two simultaneous editors cannot both overwrite the same expected version', async () => {
  const f = await fixture()
  try {
    await writeFile(f.context, 'shared.txt', 'original')
    const original = await readFile(f.context, 'shared.txt')
    const results = await Promise.allSettled([
      writeFile(f.context, 'shared.txt', 'editor one', original.hash),
      writeFile(f.context, 'shared.txt', 'editor two', original.hash)
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.ok(['editor one', 'editor two'].includes((await readFile(f.context, 'shared.txt')).content))
  } finally { await f.cleanup() }
})

test('image previews inspect actual file signatures and reject active content or paths outside the workspace', async () => {
  const f = await fixture()
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jvXkAAAAASUVORK5CYII=', 'base64')
    await fs.writeFile(path.join(f.context.cwd, 'pixel.png'), png)
    const media = await readMedia(f.context, 'pixel.png')
    assert.equal(media.mimeType, 'image/png'); assert.equal(media.dataUrl, `data:image/png;base64,${png.toString('base64')}`)
    await fs.writeFile(path.join(f.context.cwd, 'pretend.png'), '<script>active()</script>')
    await assert.rejects(readMedia(f.context, 'pretend.png'), /supports PNG/)
    await fs.symlink(f.base, path.join(f.context.cwd, 'escape'))
    await assert.rejects(readMedia(f.context, '../other.png'), /outside/)
  } finally { await f.cleanup() }
})

test('Git handles untracked diff, unborn stage/unstage, spaces and contained subprojects', async () => {
  const f = await fixture()
  try {
    assert.equal((await gitStatus(f.context)).isRepo, false)
    assert.equal((await runCommand('git', ['init', '-b', 'test'], { cwd: f.context.cwd })).code, 0)
    await writeFile(f.context, 'hello world.txt', 'hello\n')
    let status = await gitStatus(f.context)
    assert.equal(status.branch, 'test'); assert.deepEqual(status.files, [{ path: 'hello world.txt', status: '??' }])
    assert.match((await gitDiff(f.context, 'hello world.txt')).diff, /\+hello/)
    await gitStage(f.context, 'hello world.txt', true)
    assert.equal((await gitStatus(f.context)).files[0].status, 'A ')
    await gitStage(f.context, 'hello world.txt', false)
    assert.equal(await fs.readFile(path.join(f.context.cwd, 'hello world.txt'), 'utf8'), 'hello\n')
    assert.equal((await gitStatus(f.context)).files[0].status, '??')
    await writeFile(f.context, 'sub/project.txt', 'nested\n')
    const sub = { ...f.context, cwd: path.join(f.context.cwd, 'sub') }
    assert.deepEqual((await gitStatus(sub)).files, [{ path: 'project.txt', status: '??' }])
    assert.match((await gitDiff(sub, 'project.txt')).diff, /\+nested/)
    await assert.rejects(gitStage(f.context, '../outside', true), /outside/)
  } finally { await f.cleanup() }
})

test('macOS /var and /private/var name the same canonical workspace for file links and guarded saves', { skip: process.platform !== 'darwin' }, async () => {
  const base = await fs.mkdtemp('/var/tmp/akorith-var-alias-')
  try {
    const lexicalRoot = path.join(base, 'project'); await fs.mkdir(lexicalRoot)
    const canonicalRoot = await fs.realpath(lexicalRoot)
    assert.ok(canonicalRoot.startsWith('/private/var/'), 'exercise the real macOS ancestor alias')
    const context: HostContext = { cwd: canonicalRoot, taskId: 'canonical-project', mode: 'work' }
    await writeFile(context, 'journey.md', 'Türkçe içerik\n')
    const link = path.join(lexicalRoot, 'journey.md')
    assert.equal(await containedPath(canonicalRoot, link), path.join(canonicalRoot, 'journey.md'))
    const read = await readFile(context, link)
    assert.equal(read.content, 'Türkçe içerik\n')
    await fs.chmod(link, 0o600)
    await writeFile(context, link, 'İkinci tur\n', read.hash)
    assert.equal((await fs.stat(link)).mode & 0o777, 0o600)
    assert.equal((await readFile({ ...context, cwd: lexicalRoot }, path.join(canonicalRoot, 'journey.md'))).content, 'İkinci tur\n')
    await fs.writeFile(link, 'external change\n')
    await assert.rejects(writeFile(context, link, 'stale draft', sha256('İkinci tur\n')), /changed on disk/)
    assert.equal(await fs.readFile(link, 'utf8'), 'external change\n')
    await writeFile(context, path.join(lexicalRoot, 'new', 'nested.md'), 'created inside')
    assert.equal(await fs.readFile(path.join(canonicalRoot, 'new', 'nested.md'), 'utf8'), 'created inside')
  } finally { await fs.rm(base, { recursive: true, force: true }) }
})

test('workspace and ancestor aliases support existing and missing paths while sharing canonical CAS locks', async () => {
  const f = await fixture()
  try {
    const root = await fs.realpath(f.context.cwd)
    const context = { ...f.context, cwd: root }
    const workspaceAlias = path.join(f.base, 'workspace-alias')
    const parentAlias = path.join(f.base, 'parent-alias')
    await fs.symlink(root, workspaceAlias); await fs.symlink(await fs.realpath(f.base), parentAlias)
    await writeFile(context, 'folder/source.txt', 'original')
    const direct = path.join(workspaceAlias, 'folder/source.txt')
    const ancestral = path.join(parentAlias, 'project/folder/source.txt')
    assert.equal((await readFile(context, direct)).content, 'original')
    assert.equal((await readFile(context, ancestral)).content, 'original')
    assert.equal(await containedPath(root, path.join(workspaceAlias, 'new/deep/file.txt'), true), path.join(root, 'new/deep/file.txt'))
    await assert.rejects(containedPath(root, path.join(workspaceAlias, 'new/deep/file.txt')), { code: 'ENOENT' })
    await writeFile(context, path.join(workspaceAlias, 'new/deep/file.txt'), 'new data')
    assert.equal(await fs.readFile(path.join(root, 'new/deep/file.txt'), 'utf8'), 'new data')
    await fs.symlink('folder', path.join(root, 'valid-internal'))
    assert.equal((await readFile(context, path.join(workspaceAlias, 'valid-internal/source.txt'))).content, 'original')
    const results = await Promise.allSettled([
      writeFile(context, direct, 'alias editor', sha256('original')),
      writeFile(context, path.join(root, 'folder/source.txt'), 'canonical editor', sha256('original'))
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.ok(['alias editor', 'canonical editor'].includes(await fs.readFile(path.join(root, 'folder/source.txt'), 'utf8')))
  } finally { await f.cleanup() }
})

test('alias recognition cannot skip an escaping segment or grant external file/subdirectory aliases', async () => {
  const f = await fixture()
  try {
    const root = await fs.realpath(f.context.cwd); const context = { ...f.context, cwd: root }
    const alias = path.join(f.base, 'workspace-alias'); await fs.symlink(root, alias)
    const outside = path.join(f.base, 'outside'); await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'other.txt'), 'outside remains')
    await writeFile(context, 'folder/source.txt', 'inside remains')
    await fs.symlink(outside, path.join(root, 'escape'))
    await fs.symlink(root, path.join(outside, 'back-to-workspace'))
    await fs.symlink(path.join(root, 'folder'), path.join(outside, 'subdirectory-alias'))
    await fs.symlink(path.join(root, 'folder/source.txt'), path.join(outside, 'file-alias.txt'))
    for (const input of [
      path.join(alias, 'escape/other.txt'),
      path.join(alias, 'escape/back-to-workspace/folder/source.txt'),
      path.join(alias, 'escape/new/deep/file.txt'),
      path.join(outside, 'subdirectory-alias/source.txt'),
      path.join(outside, 'file-alias.txt'),
      path.join(f.base, 'project-sibling/new.txt'),
      '../workspace-alias/folder/source.txt'
    ]) {
      await assert.rejects(containedPath(root, input, true), /outside/)
      await assert.rejects(writeFile(context, input, 'not authorized'), /outside/)
    }
    assert.equal(await fs.readFile(path.join(outside, 'other.txt'), 'utf8'), 'outside remains')
    assert.equal(await fs.readFile(path.join(root, 'folder/source.txt'), 'utf8'), 'inside remains')
    await assert.rejects(fs.access(path.join(outside, 'new')))
  } finally { await f.cleanup() }
})

test('missing paths stay contained and existing dangling links are never mistaken for missing directories', async () => {
  const f = await fixture()
  try {
    const root = await fs.realpath(f.context.cwd); const context = { ...f.context, cwd: root }
    const alias = path.join(f.base, 'workspace-alias'); await fs.symlink(root, alias)
    const missingOutside = path.join(f.base, 'outside-not-created')
    await fs.symlink(missingOutside, path.join(root, 'dangling-external'))
    await fs.symlink(path.join(root, 'not-created'), path.join(root, 'dangling-internal'))
    for (const input of ['dangling-external', 'dangling-external/new/file.txt', path.join(alias, 'dangling-external/new/file.txt'), path.join(alias, 'dangling-internal/new/file.txt')]) {
      await assert.rejects(containedPath(root, input, true), /symbolic link/)
      await assert.rejects(writeFile(context, input, 'not written'), /symbolic link/)
    }
    await assert.rejects(fs.access(missingOutside))
    await assert.rejects(fs.access(path.join(root, 'not-created')))
    await assert.rejects(containedPath(root, path.join(f.base, 'nonexistent-alias/new/file.txt'), true), /outside/)
    await fs.symlink('cycle-b', path.join(root, 'cycle-a')); await fs.symlink('cycle-a', path.join(root, 'cycle-b'))
    await assert.rejects(containedPath(root, path.join(alias, 'cycle-a/new.txt'), true), { code: 'ELOOP' })
    await writeFile(context, path.join(alias, 'ordinary/missing/file.txt'), 'safe new file')
    assert.equal(await fs.readFile(path.join(root, 'ordinary/missing/file.txt'), 'utf8'), 'safe new file')
  } finally { await f.cleanup() }
})
