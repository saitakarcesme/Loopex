/** Offline synthetic fixtures only. This file never invokes a model or provider. */
import { mkdtempSync, mkdirSync, existsSync, readdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { Store } from '../../main/storage'

const flag = (name: string) => { const index = process.argv.indexOf(name); return index >= 0 ? process.argv[index + 1] : undefined }
const integer = (name: string, fallback: number) => { const value = Number(flag(name) ?? fallback); if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`); return value }
const taskCount = integer('--tasks', 1000), messageCount = integer('--messages', 10000)
if (messageCount % 2 || messageCount < taskCount * 2) throw new Error('--messages must be even and at least twice --tasks')
const requested = flag('--user-data')
const userData = requested ? resolve(requested) : mkdtempSync(join(tmpdir(), 'akorith-performance-'))
if (existsSync(userData) && readdirSync(userData).length) throw new Error('Synthetic seeding requires a new, empty user-data directory. Existing app data is never overwritten.')
mkdirSync(userData, { recursive: true })
const started = performance.now(), store = new Store(join(userData, 'workspace.sqlite'))
const marker = 'SYNTHETIC PERFORMANCE FIXTURE — no model was run.'
const sentence = 'Türkçe: İstanbul, ığüşöç İĞÜŞÖÇ. Emoji: 👩🏽‍💻 🧪 🌍 🚀. Bu metin yalnızca arayüz performansını ölçmek için üretildi.'
const code = (lines: number) => '```typescript\n' + Array.from({ length: lines }, (_, index) => `const syntheticRow${index} = { id: ${index}, label: "İstanbul 👩🏽‍💻 ${index}", verified: false };`).join('\n') + '\n```'
const table = '| ' + Array.from({ length: 18 }, (_, index) => `Column ${index + 1}`).join(' | ') + ' |\n| ' + Array(18).fill('---').join(' | ') + ' |\n' + Array.from({ length: 80 }, (_, row) => '| ' + Array.from({ length: 18 }, (_, column) => `Synthetic ${row}:${column} 🌍`).join(' | ') + ' |').join('\n')
const totalTurns = messageCount / 2
const heavyTurns = taskCount === 1 ? totalTurns : Math.min(500, totalTurns - (taskCount - 1))
const remaining = totalTurns - heavyTurns
const normalTurns = taskCount === 1 ? 0 : Math.floor(remaining / (taskCount - 1))
const extra = taskCount === 1 ? 0 : remaining % (taskCount - 1)
const taskIds: string[] = []
const base = Date.now()
try {
  store.db.transaction(() => {
    store.saveSettings({ theme: 'dark', defaultProvider: 'codex', skills: [], mcpServers: [] })
    for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
      const task = store.createTask({ title: taskIndex === 0 ? '[SYNTHETIC] Long conversation · Türkçe 👩🏽‍💻' : `[SYNTHETIC] Task ${String(taskIndex).padStart(4, '0')} · İstanbul 🌍`, providerId: 'codex', model: '' })
      taskIds.push(task.id)
      const turns = taskIndex === 0 ? heavyTurns : normalTurns + (taskIndex <= extra ? 1 : 0)
      for (let turnIndex = 0; turnIndex < turns; turnIndex++) {
        const prompt = `${marker}\nTask ${taskIndex}, turn ${turnIndex}. ${sentence}`
        const turn = store.acceptTurn(task.id, `synthetic-${taskIndex}-${turnIndex}`, prompt, []).turn
        store.setTurnStatus(turn.id, 'completed')
        store.saveMessage({ ...store.message(`${turn.id}:user`), status: 'completed' })
        let content = `${marker}\n\n${sentence}\n\nThis deterministic response tests text layout, wrapping, and scrolling. It does not report any real work.`
        if (taskIndex === 0 && turnIndex === turns - 1) content += '\n\n' + code(1200) + '\n\n' + table
        else if (taskIndex === 0 && turnIndex % 25 === 0) content += '\n\n' + code(45)
        store.saveMessage({ ...store.message(`${turn.id}:assistant`), status: 'completed', content })
      }
      store.updateTask(task.id, { status: 'completed', updatedAt: base + taskCount - taskIndex, draft: '', nativeSessions: {} })
    }
  })()
  const actualTasks = (store.db.prepare('SELECT COUNT(*) AS value FROM tasks').get() as { value: number }).value
  const actualMessages = (store.db.prepare('SELECT COUNT(*) AS value FROM messages').get() as { value: number }).value
  if (actualTasks !== taskCount || actualMessages !== messageCount) throw new Error(`Fixture count mismatch: ${actualTasks} tasks, ${actualMessages} messages`)
  const metadata = {
    synthetic: true, modelRuns: 0, label: marker, createdAt: new Date().toISOString(), userData,
    seedSourceSha256: createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex'),
    storeSourceSha256: createHash('sha256').update(readFileSync(fileURLToPath(new URL('../../main/storage.ts', import.meta.url)))).digest('hex'),
    attributedMessages: (store.db.prepare("SELECT COUNT(*) AS value FROM messages WHERE json_type(data,'$.attribution') IS NOT NULL").get() as { value: number }).value,
    taskCount: actualTasks, messageCount: actualMessages, heavyTaskId: taskIds[0], heavyMessageCount: heavyTurns * 2,
    switchTaskIds: [taskIds[0], taskIds[Math.min(1, taskIds.length - 1)], taskIds[Math.floor(taskIds.length / 2)], taskIds.at(-1)!],
    seedMs: Math.round(performance.now() - started),
  }
  writeFileSync(join(userData, 'synthetic-performance.json'), JSON.stringify(metadata, null, 2) + '\n')
  process.stdout.write(JSON.stringify(metadata, null, 2) + '\n')
} finally { store.close() }
