import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { CheckpointManager } from '../../main/checkpoints'
import { sha256, withFileWriteLock, writeFile } from '../../main/host/files'
import { runCommand } from '../../main/host/process'

async function fixture(budgets = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'akorith-checkpoints-test-'))
  const cwd = path.join(base, 'project'); const userData = path.join(base, 'data')
  await Promise.all([fs.mkdir(cwd), fs.mkdir(userData)])
  return { base, cwd, userData, manager: new CheckpointManager(userData, budgets), cleanup: () => fs.rm(base, { recursive: true, force: true }) }
}

test('per-turn changes use the dirty baseline, not Git HEAD; created/deleted/modified undo preserves mode and retained data', async () => {
  const f = await fixture()
  try {
    await runCommand('git', ['init', '-q'], { cwd: f.cwd })
    await fs.writeFile(path.join(f.cwd, 'dirty.sh'), 'user dirty baseline\n', { mode: 0o751 })
    await fs.writeFile(path.join(f.cwd, 'deleted.txt'), 'restore this\n')
    await fs.chmod(path.join(f.cwd, 'deleted.txt'), 0o664)
    await fs.writeFile(path.join(f.cwd, 'unchanged.txt'), 'unchanged but already dirty\n')
    await f.manager.begin('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'dirty.sh'), 'agent changes\n')
    await fs.chmod(path.join(f.cwd, 'dirty.sh'), 0o644)
    await fs.unlink(path.join(f.cwd, 'deleted.txt'))
    await fs.writeFile(path.join(f.cwd, 'created.txt'), 'created in turn\n')
    const finished = await f.manager.finish('task', 'turn', f.cwd)
    assert.deepEqual(finished.changes.map(item => [item.path, item.status]), [['created.txt', 'created'], ['deleted.txt', 'deleted'], ['dirty.sh', 'modified']])
    assert.equal(finished.changes.find(item => item.path === 'dirty.sh')?.beforeHash, sha256('user dirty baseline\n'))
    assert.equal((await f.manager.read('task', 'turn', 'dirty.sh')).before, 'user dirty baseline\n')
    assert.equal((await f.manager.read('task', 'turn', 'dirty.sh')).after, 'agent changes\n')
    await f.manager.undo('task', 'turn', 'dirty.sh', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'dirty.sh'), 'utf8'), 'user dirty baseline\n')
    assert.equal((await fs.stat(path.join(f.cwd, 'dirty.sh'))).mode & 0o777, 0o751)
    await f.manager.undo('task', 'turn', 'deleted.txt', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'deleted.txt'), 'utf8'), 'restore this\n')
    assert.equal((await fs.stat(path.join(f.cwd, 'deleted.txt'))).mode & 0o777, 0o664)
    const created = await f.manager.undo('task', 'turn', 'created.txt', f.cwd)
    assert.ok(created.retainedPath)
    assert.equal(await fs.readFile(created.retainedPath!, 'utf8'), 'created in turn\n')
    await assert.rejects(fs.access(path.join(f.cwd, 'created.txt')))
    assert.equal((await f.manager.list('turn', 'task'))?.changes.filter(item => item.undoneAt).length, 3)
    await assert.rejects(f.manager.undo('task', 'turn', 'created.txt', f.cwd), /already been undone/)
    assert.equal(await fs.readFile(path.join(f.cwd, 'unchanged.txt'), 'utf8'), 'unchanged but already dirty\n')
  } finally { await f.cleanup() }
})

test('undo refuses later text or mode changes and refuses recreating a deleted path occupied by newer work', async () => {
  const f = await fixture()
  try {
    for (const file of ['modified.txt', 'deleted.txt', 'mode.txt']) await fs.writeFile(path.join(f.cwd, file), 'before')
    await f.manager.begin('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'modified.txt'), 'after')
    await fs.unlink(path.join(f.cwd, 'deleted.txt'))
    await fs.chmod(path.join(f.cwd, 'mode.txt'), 0o755)
    await fs.writeFile(path.join(f.cwd, 'created.txt'), 'after')
    await f.manager.finish('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'modified.txt'), 'newer user work')
    await fs.writeFile(path.join(f.cwd, 'deleted.txt'), 'newer recreated file')
    await fs.writeFile(path.join(f.cwd, 'created.txt'), 'newer created-file edit')
    await fs.chmod(path.join(f.cwd, 'mode.txt'), 0o600)
    for (const file of ['modified.txt', 'deleted.txt', 'created.txt', 'mode.txt']) await assert.rejects(f.manager.undo('task', 'turn', file, f.cwd), /changed after the turn/)
    assert.equal(await fs.readFile(path.join(f.cwd, 'modified.txt'), 'utf8'), 'newer user work')
    assert.equal(await fs.readFile(path.join(f.cwd, 'deleted.txt'), 'utf8'), 'newer recreated file')
  } finally { await f.cleanup() }
})

test('begin and finish are idempotent; persisted evidence survives manager restarts and verifies task/workspace mapping', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'before')
    const began = await f.manager.begin('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'after')
    assert.equal((await f.manager.begin('task', 'turn', f.cwd)).startedAt, began.startedAt)
    await f.manager.finish('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'newer')
    const restarted = new CheckpointManager(f.userData)
    assert.equal((await restarted.finish('task', 'turn', f.cwd)).changes[0].afterHash, sha256('after'))
    assert.equal((await restarted.read('task', 'turn', 'file.txt')).before, 'before')
    await assert.rejects(restarted.begin('other', 'turn', f.cwd), /another task/)
    await assert.rejects(restarted.list('turn', 'other'), /another task/)
    await assert.rejects(restarted.undo('other', 'turn', 'file.txt', f.cwd), /another task/)
    await assert.rejects(restarted.undo('task', 'turn', 'file.txt', f.base), /another workspace/)
    await assert.rejects(restarted.list('../turn'), /Invalid turn/)
    await assert.rejects(restarted.read('task', 'turn', '../file.txt'), /Invalid checkpoint/)
    assert.equal(await restarted.list('not-recorded'), null)
  } finally { await f.cleanup() }
})

test('secrets, dependency/build output and symlinks are excluded; changing a tracked path to a link cannot escape on undo', async () => {
  const f = await fixture()
  try {
    await fs.mkdir(path.join(f.cwd, 'node_modules')); await fs.mkdir(path.join(f.cwd, 'build'))
    const excluded = ['.env', '.env.production', '.npmrc', 'credentials.json', 'private.key', 'node_modules/dependency.js', 'build/generated.js']
    for (const file of excluded) await fs.writeFile(path.join(f.cwd, file), 'DO_NOT_CAPTURE_SECRET')
    await fs.writeFile(path.join(f.base, 'outside.txt'), 'outside protected')
    await fs.symlink(f.base, path.join(f.cwd, 'external'))
    await fs.writeFile(path.join(f.cwd, 'tracked.txt'), 'before')
    await fs.symlink('tracked.txt', path.join(f.cwd, 'internal-alias.txt'))
    await f.manager.begin('task', 'turn', f.cwd)
    for (const file of excluded) await fs.writeFile(path.join(f.cwd, file), 'DO_NOT_CAPTURE_CHANGED_SECRET')
    await fs.writeFile(path.join(f.cwd, 'tracked.txt'), 'after')
    const result = await f.manager.finish('task', 'turn', f.cwd)
    assert.deepEqual(result.changes.map(change => change.path), ['tracked.txt'])
    const blobs = await fs.readdir(path.join(f.userData, 'checkpoints/turn/blobs'))
    for (const blob of blobs) assert.doesNotMatch(await fs.readFile(path.join(f.userData, 'checkpoints/turn/blobs', blob), 'utf8'), /DO_NOT_CAPTURE/)
    await fs.unlink(path.join(f.cwd, 'tracked.txt')); await fs.symlink(path.join(f.base, 'outside.txt'), path.join(f.cwd, 'tracked.txt'))
    await assert.rejects(f.manager.undo('task', 'turn', 'tracked.txt', f.cwd), /symbolic links/)
    assert.equal(await fs.readFile(path.join(f.base, 'outside.txt'), 'utf8'), 'outside protected')
  } finally { await f.cleanup() }
})

test('budget omissions are explicit and never invent creations/deletions from unscanned coverage', async () => {
  const f = await fixture({ maxFiles: 1, maxBytes: 20, maxFileBytes: 10, maxEntries: 5 })
  try {
    await fs.writeFile(path.join(f.cwd, 'a.txt'), 'before')
    await fs.writeFile(path.join(f.cwd, 'b.txt'), 'existing')
    await fs.writeFile(path.join(f.cwd, 'large.txt'), 'much larger than per-file budget')
    const before = await f.manager.begin('task', 'turn', f.cwd)
    assert.equal(before.complete, false); assert.match(before.warnings.join(' '), /budget/)
    await fs.unlink(path.join(f.cwd, 'a.txt'))
    await fs.writeFile(path.join(f.cwd, 'b.txt'), 'changed')
    await fs.writeFile(path.join(f.cwd, 'new.txt'), 'new')
    const after = await f.manager.finish('task', 'turn', f.cwd)
    assert.deepEqual(after.changes.map(change => [change.path, change.status]), [['a.txt', 'deleted']])
    assert.match(after.warnings.join(' '), /partial/)
    await f.manager.undo('task', 'turn', 'a.txt', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'a.txt'), 'utf8'), 'before')
  } finally { await f.cleanup() }
})

test('two-turn checkpoints preserve each turn’s baseline and reject undoing an earlier turn over a later one', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'zero')
    await f.manager.begin('task', 'turn1', f.cwd); await fs.writeFile(path.join(f.cwd, 'file.txt'), 'one'); await f.manager.finish('task', 'turn1', f.cwd)
    await f.manager.begin('task', 'turn2', f.cwd); await fs.writeFile(path.join(f.cwd, 'file.txt'), 'two'); await f.manager.finish('task', 'turn2', f.cwd)
    await assert.rejects(f.manager.undo('task', 'turn1', 'file.txt', f.cwd), /changed after the turn/)
    await f.manager.undo('task', 'turn2', 'file.txt', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'one')
    await f.manager.undo('task', 'turn1', 'file.txt', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'zero')
  } finally { await f.cleanup() }
})

test('corrupted snapshot content cannot be restored over the current file', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'before')
    await f.manager.begin('task', 'turn', f.cwd); await fs.writeFile(path.join(f.cwd, 'file.txt'), 'after'); await f.manager.finish('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.userData, 'checkpoints/turn/blobs', `${sha256('before')}.txt`), 'broken')
    await assert.rejects(f.manager.undo('task', 'turn', 'file.txt', f.cwd), /integrity check/)
    assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'after')
  } finally { await f.cleanup() }
})

test('exclusive restoration never overwrites a concurrently recreated path', async () => {
  const f = await fixture()
  try {
    const context = { taskId: 'task', cwd: f.cwd, mode: 'work' as const }
    const results = await Promise.allSettled([
      writeFile(context, 'deleted.txt', 'checkpoint restore', undefined, { expectedAbsent: true, mode: 0o750 }),
      writeFile(context, 'deleted.txt', 'new user file', undefined, { expectedAbsent: true })
    ])
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
    assert.equal(results.filter(result => result.status === 'rejected').length, 1)
    assert.ok(['checkpoint restore', 'new user file'].includes(await fs.readFile(path.join(f.cwd, 'deleted.txt'), 'utf8')))
  } finally { await f.cleanup() }
})

test('checkpoint storage inside a project does not recursively snapshot its own blobs', async () => {
  const f = await fixture()
  try {
    const manager = new CheckpointManager(path.join(f.cwd, 'app-data'))
    await fs.writeFile(path.join(f.cwd, 'source.txt'), 'before')
    const before = await manager.begin('task', 'turn', f.cwd)
    assert.equal(before.beforeFiles, 1)
    await fs.writeFile(path.join(f.cwd, 'source.txt'), 'after')
    const after = await manager.finish('task', 'turn', f.cwd)
    assert.deepEqual(after.changes.map(change => change.path), ['source.txt'])
  } finally { await f.cleanup() }
})

test('interrupted undo after atomic restore is reconciled without applying it twice', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'before')
    await f.manager.begin('task', 'turn', f.cwd); await fs.writeFile(path.join(f.cwd, 'file.txt'), 'after'); await f.manager.finish('task', 'turn', f.cwd)
    const metadataPath = path.join(f.userData, 'checkpoints/turn/manifest.json')
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    metadata.undo = { path: 'file.txt', startedAt: Date.now() }
    await fs.writeFile(metadataPath, JSON.stringify(metadata))
    await fs.writeFile(path.join(f.cwd, 'file.txt'), 'before')
    const restarted = new CheckpointManager(f.userData)
    assert.match((await restarted.list('turn', 'task'))!.warnings.join(' '), /interrupted/)
    const undone = await restarted.undo('task', 'turn', 'file.txt', f.cwd)
    assert.ok(undone.change.undoneAt)
    assert.equal(await fs.readFile(path.join(f.cwd, 'file.txt'), 'utf8'), 'before')
    assert.doesNotMatch((await restarted.list('turn', 'task'))!.warnings.join(' '), /interrupted/)
  } finally { await f.cleanup() }
})

test('interrupted created-file move validates retained contents before marking undo complete', async () => {
  const f = await fixture()
  try {
    await f.manager.begin('task', 'turn', f.cwd); await fs.writeFile(path.join(f.cwd, 'created.txt'), 'created'); await f.manager.finish('task', 'turn', f.cwd)
    const metadataPath = path.join(f.userData, 'checkpoints/turn/manifest.json')
    const metadata = JSON.parse(await fs.readFile(metadataPath, 'utf8'))
    metadata.undo = { path: 'created.txt', trash: 'trash/retained.txt', startedAt: Date.now() }
    await fs.mkdir(path.join(f.userData, 'checkpoints/turn/trash'))
    await fs.rename(path.join(f.cwd, 'created.txt'), path.join(f.userData, 'checkpoints/turn/trash/retained.txt'))
    await fs.writeFile(metadataPath, JSON.stringify(metadata))
    const restarted = new CheckpointManager(f.userData)
    const result = await restarted.undo('task', 'turn', 'created.txt', f.cwd)
    assert.equal(await fs.readFile(result.retainedPath!, 'utf8'), 'created')
    assert.ok(result.change.undoneAt)
  } finally { await f.cleanup() }
})

test('a writer racing with created-file undo is preserved and the failed undo does not block other files', async () => {
  const f = await fixture()
  try {
    await fs.writeFile(path.join(f.cwd, 'other.txt'), 'before')
    await f.manager.begin('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'created.txt'), 'created'); await fs.writeFile(path.join(f.cwd, 'other.txt'), 'after')
    await f.manager.finish('task', 'turn', f.cwd)
    let release!: () => void; let held!: () => void
    const gate = new Promise<void>(resolve => { release = resolve }); const acquired = new Promise<void>(resolve => { held = resolve })
    const writer = withFileWriteLock({ taskId: 'task', cwd: f.cwd, mode: 'work' }, 'created.txt', async target => { held(); await gate; await fs.writeFile(target, 'newer concurrent work') })
    await acquired
    const undo = f.manager.undo('task', 'turn', 'created.txt', f.cwd)
    const expectedRejection = assert.rejects(undo, /changed while undoing/)
    const deadline = Date.now() + 3000
    while (Date.now() < deadline) {
      const manifest = JSON.parse(await fs.readFile(path.join(f.userData, 'checkpoints/turn/manifest.json'), 'utf8'))
      if (manifest.undo) break
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    release(); await writer; await expectedRejection
    assert.equal(await fs.readFile(path.join(f.cwd, 'created.txt'), 'utf8'), 'newer concurrent work')
    await f.manager.undo('task', 'turn', 'other.txt', f.cwd)
    assert.equal(await fs.readFile(path.join(f.cwd, 'other.txt'), 'utf8'), 'before')
  } finally { await f.cleanup() }
})

test('undo preserves UTF-8 byte order marks, CRLF and empty files exactly', async () => {
  const f = await fixture()
  try {
    const original = Buffer.from('\uFEFFTÜRKÇE\r\nsecond line\r\n', 'utf8')
    await fs.writeFile(path.join(f.cwd, 'original.txt'), original)
    await fs.writeFile(path.join(f.cwd, 'empty.txt'), '')
    await f.manager.begin('task', 'turn', f.cwd)
    await fs.writeFile(path.join(f.cwd, 'original.txt'), 'changed\n')
    await fs.unlink(path.join(f.cwd, 'empty.txt'))
    await f.manager.finish('task', 'turn', f.cwd)
    await f.manager.undo('task', 'turn', 'original.txt', f.cwd)
    await f.manager.undo('task', 'turn', 'empty.txt', f.cwd)
    assert.deepEqual(await fs.readFile(path.join(f.cwd, 'original.txt')), original)
    assert.equal((await fs.stat(path.join(f.cwd, 'empty.txt'))).size, 0)
  } finally { await f.cleanup() }
})
