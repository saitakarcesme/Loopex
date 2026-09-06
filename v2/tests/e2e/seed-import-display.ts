/** Offline synthetic import only. No legacy user data, provider, model, or GUI is opened. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const protocol = 'akorith-import-display-fixture-v1'
const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')

async function main() {
  const args = process.argv.slice(2)
  if (!args.length) {
    console.log('Offline disposable fixture: ELECTRON_RUN_AS_NODE=1 electron --import tsx v2/tests/e2e/seed-import-display.ts --create --nonce <32 lowercase hex characters>')
    return
  }
  if (args.length !== 3 || args[0] !== '--create' || args[1] !== '--nonce' || !/^[a-f0-9]{32}$/.test(args[2])) {
    throw new Error('Only --create --nonce <32 lowercase hex characters> is accepted. Existing source/user-data paths are never accepted.')
  }
  const nonce = args[2]
  // Validate all flags before loading native SQLite or creating the owned fixture.
  const [{ default: Database }, { Store }, { importLegacy }] = await Promise.all([
    import('better-sqlite3'), import('../../main/storage'), import('../../main/migration'),
  ])
  const root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), 'akorith-history-display-')))
  const legacyRoot = join(root, 'legacy'), userData = join(root, 'data'), project = join(root, 'project')
  for (const folder of [legacyRoot, userData, project]) mkdirSync(folder)
  const sourcePath = join(legacyRoot, 'loopex.db')
  const markerPath = join(root, 'fixture.json')
  const createdAt = new Date().toISOString()
  writeFileSync(markerPath, JSON.stringify({ protocol, synthetic: true, nonce, root, createdAt, state: 'seeding' }) + '\n', { flag: 'wx' })
  writeFileSync(join(project, 'SYNTHETIC.txt'), 'This disposable project is for imported-history display acceptance. No model was run.\n', { flag: 'wx' })
  const taskTitle = `[SYNTHETIC] Imported outcome evidence ${nonce.slice(0, 8)}`
  const longModel = `historical-unrecognized-model-${'preserve-exact-label-'.repeat(9)}Türkçe`
  const rows = [
    { id: 'user', role: 'user', provider: 'chatgpt', model: 'historical-user-model', content: 'Synthetic request. These historical records do not describe real work.', metadata: undefined },
    {
      id: 'parent-completed', role: 'assistant', provider: 'chatgpt', model: 'historical-codex-model',
      content: 'SYNTHETIC: Parent completed; child outcomes are independent.',
      metadata: { chatLifecycle: { state: 'completed' }, activities: [
        { id: 'child-running', kind: 'command', label: 'Synthetic running child', status: 'running', detail: 'No terminal outcome was present in the old record.', timestamp: 2100 },
        { id: 'child-unknown', kind: 'plan', label: 'Synthetic unknown child', detail: 'No child status was present in the old record.', timestamp: 2200 },
        null,
      ] },
    },
    {
      id: 'timed-out', role: 'assistant', provider: 'claude', model: 'historical-claude-model',
      content: 'SYNTHETIC: Partial text survived a timed-out turn.',
      metadata: { chatLifecycle: { state: 'timed_out' }, activities: [
        { id: 'timeout-error', kind: 'command', label: 'Synthetic timed-out command', status: 'error', timestamp: 2300 },
      ] },
    },
    { id: 'missing-outcome', role: 'assistant', provider: 'local', model: 'historical-local-model', content: 'SYNTHETIC: This turn has no recorded lifecycle outcome.', metadata: undefined },
    {
      id: 'paused-goal', role: 'assistant', provider: 'opencode', model: 'historical-opencode-model',
      content: 'SYNTHETIC: This is a paused historical goal, not a running goal.',
      metadata: { workspaceGoal: { status: 'paused', final: false }, activities: [
        { id: 'goal-running', kind: 'plan', label: 'Synthetic paused goal activity', status: 'running', timestamp: 2500 },
      ] },
    },
    { id: 'unknown-provider', role: 'assistant', provider: 'legacy-unknown-provider', model: longModel, content: 'SYNTHETIC: Preserve an unknown provider and its long original model label.', metadata: undefined },
  ]
  const legacy = new Database(sourcePath)
  let store: InstanceType<typeof Store> | undefined
  try {
    legacy.exec(`
      CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,path TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,title TEXT NOT NULL,project_id TEXT,pinned INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
      CREATE TABLE messages(id TEXT PRIMARY KEY,session_id TEXT NOT NULL,role TEXT NOT NULL CHECK(role IN ('user','assistant')),content TEXT NOT NULL,provider_id TEXT NOT NULL,model TEXT,attachments TEXT,metadata TEXT,created_at INTEGER NOT NULL);
    `)
    legacy.prepare('INSERT INTO projects VALUES(?,?,?,?,?)').run('project', '[SYNTHETIC] Import display', project, 900, 1000)
    legacy.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?,?)').run('history', 'chatgpt', taskTitle, 'project', 1, 1000, 8000)
    const attachmentFolder = join(legacyRoot, 'chat-attachments', 'history', 'request')
    mkdirSync(attachmentFolder, { recursive: true })
    const attachmentPath = join(attachmentFolder, 'synthetic-attachment.txt')
    const attachmentContent = 'Synthetic historical attachment.\n'
    writeFileSync(attachmentPath, attachmentContent, { flag: 'wx' })
    const attachment = { id: 'synthetic-attachment', name: 'synthetic-attachment.txt', path: attachmentPath, mimeType: 'text/plain', size: Buffer.byteLength(attachmentContent) }
    rows.forEach((row, index) => legacy.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)').run(
      row.id, 'history', row.role, row.content, row.provider, row.model,
      row.role === 'user' ? JSON.stringify([attachment]) : null,
      row.metadata ? JSON.stringify(row.metadata) : null, 2000 + index * 1000,
    ))
    legacy.close()
    const sourceBefore = hash(sourcePath), attachmentBefore = hash(attachmentPath)
    store = new Store(join(userData, 'workspace.sqlite'))
    store.saveSettings({ theme: 'light', defaultProvider: 'codex', skills: [], mcpServers: [] })
    const receipt = await importLegacy(store, userData, sourcePath)
    assert.equal(hash(sourcePath), sourceBefore, 'Read-only import must preserve the synthetic source')
    assert.equal(hash(attachmentPath), attachmentBefore)
    assert.equal(receipt.projects, 1); assert.equal(receipt.tasks, 1); assert.equal(receipt.messages, 6)
    assert.equal(receipt.attachments, 1); assert.equal(receipt.unverifiedMessages, 3)
    assert.deepEqual(receipt.skipped, { projects: 0, tasks: 0, messages: 0, attachments: 0, activities: 1, metadata: 0 })
    const task = store.tasks()[0], messages = store.messages(task.id)
    assert.equal(task.title, taskTitle); assert.equal(task.providerId, 'opencode'); assert.equal(task.model, 'historical-opencode-model')
    assert.deepEqual(task.nativeSessions, {})
    assert.equal((store.db.prepare('SELECT COUNT(*) AS count FROM turns').get() as { count: number }).count, 0)
    const expected = [
      { legacyId: 'parent-completed', status: 'completed', attribution: 'Codex · historical-codex-model', activities: [['Synthetic running child', 'interrupted'], ['Synthetic unknown child', 'unknown']] },
      { legacyId: 'timed-out', status: 'failed', attribution: 'Claude · historical-claude-model', outcome: 'This imported turn timed out. Partial work is preserved.', activities: [['Synthetic timed-out command', 'failed']] },
      { legacyId: 'missing-outcome', status: 'interrupted', attribution: 'Ollama · historical-local-model', outcome: 'Imported history. The outcome was not recorded.', activities: [] },
      { legacyId: 'paused-goal', status: 'interrupted', attribution: 'OpenCode · historical-opencode-model', outcome: 'Imported history. The outcome was not recorded.', goal: 'Previous goal: paused. Historical record.', activities: [['Synthetic paused goal activity', 'interrupted']] },
      { legacyId: 'unknown-provider', status: 'interrupted', attribution: `Unknown provider (legacy-unknown-provider) · ${longModel}`, outcome: 'Imported history. The outcome was not recorded.', activities: [] },
    ].map(row => {
      const message = messages.find(message => message.importProvenance?.messageId === row.legacyId)
      assert.ok(message); assert.equal(message.status, row.status)
      assert.deepEqual(message.activities.map(activity => [activity.title, activity.status]), row.activities)
      return { ...row, id: message.id, turnId: message.turnId }
    })
    store.close(); store = undefined
    const manifest = {
      protocol, synthetic: true, modelRuns: 0, createdAt, seededAt: new Date().toISOString(), state: 'ready',
      nonce, root, userData, project, sourcePath, taskId: task.id, taskTitle, taskProvider: task.providerId, taskModel: task.model,
      messageCount: messages.length, expected, receipt, sourceSha256: sourceBefore, sourceUnchanged: true,
      targetSha256: hash(join(userData, 'workspace.sqlite')),
      seedSourceSha256: hash(fileURLToPath(import.meta.url)),
      migrationSourceSha256: hash(fileURLToPath(new URL('../../main/migration.ts', import.meta.url))),
      storageSourceSha256: hash(fileURLToPath(new URL('../../main/storage.ts', import.meta.url))),
    }
    writeFileSync(markerPath, JSON.stringify(manifest, null, 2) + '\n')
    process.stdout.write(JSON.stringify({ markerPath, nonce, root }) + '\n')
  } catch (error) {
    writeFileSync(join(root, 'seed-error.txt'), error instanceof Error ? error.stack ?? error.message : String(error))
    console.error(`Synthetic fixture retained at ${root}`)
    throw error
  } finally {
    if (legacy.open) legacy.close()
    store?.close()
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1 })
