import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Activity, Message } from '../../shared/contracts'
import { ActivityRow, MessageView } from '../src/components/Transcript'

const noop = () => {}
const response: Message = {
  id: 'imported-response', taskId: 'history', turnId: 'import:old-message',
  role: 'assistant', content: 'Saved partial response.', createdAt: 1000,
  status: 'interrupted', activities: [],
  importProvenance: { source: 'akorith', messageId: 'old-message', outcomeRecorded: false },
}
const render = (message: Message) => renderToStaticMarkup(
  <MessageView message={message} undoBlockReason={null} onOpenFile={noop} onError={noop} onOverlay={noop} onContext={noop} />,
)

test('inactive imported activities never show a spinner or plan success icon', () => {
  for (const status of ['interrupted', 'unknown'] as const) {
    for (const kind of ['plan', 'command', 'commentary'] as const) {
      const activity: Activity = {
        id: 'old-action', kind, title: 'Saved operation', status, startedAt: 1000,
        importProvenance: { source: 'akorith', originalStatus: 'running' },
      }
      const html = renderToStaticMarkup(<ActivityRow activity={activity} onOpenFile={noop} onError={noop} />)
      assert.match(html, /Outcome not recorded/)
      assert.doesNotMatch(html, /spinner|lucide-check|>Failed</)
    }
  }
})

test('history without an outcome is readable without a fabricated failure or success', () => {
  const html = render(response)
  assert.match(html, /Saved partial response/)
  assert.match(html, /The outcome was not recorded/)
  assert.doesNotMatch(html, /Details are shown above|Completed|live-orb/)
})

test('a recorded timeout and historical goal retain their specific meaning', () => {
  const html = render({ ...response, status: 'failed', importProvenance: {
    ...response.importProvenance!, outcomeRecorded: true, lifecycle: 'timed_out',
    workspaceGoal: { status: 'paused', final: false },
  } })
  assert.match(html, /imported turn timed out/)
  assert.match(html, /Previous goal: paused. Historical record/)
  assert.doesNotMatch(html, /live-orb|Resume goal/)
})

test('message attribution comes from its recorded provider and escapes unfamiliar identities', () => {
  const html = render({ ...response, attribution: { providerId: 'claude', originalProviderId: 'claude', model: 'historic-model' } })
  assert.match(html, /Claude · historic-model/)
  assert.doesNotMatch(html, /Codex/)
  const unknown = render({ ...response, attribution: { originalProviderId: '<unknown>', model: 'old-model' } })
  assert.match(unknown, /Unknown provider \(&lt;unknown&gt;\)/)
  assert.doesNotMatch(unknown, /Claude|<unknown>/)
})

test('empty and failed assistant turns retain context inspection without a fake response', () => {
  const html = render({ ...response, content: '', status: 'failed', importProvenance: undefined })
  assert.match(html, /aria-label="Inspect turn context"/)
  assert.doesNotMatch(html, /Copy response/)
})

test('wildcard approval details stay explicit without inventing a command or file target', async () => {
  const { PendingCard } = await import('../src/components/Transcript')
  const html = renderToStaticMarkup(<PendingCard request={{ id: 'approval', taskId: 'task', turnId: 'turn', kind: 'approval', title: 'Files read', detail: '*' }} onRespond={async () => {}} onError={noop} />)
  assert.match(html, /<pre class="pending-detail">\*<\/pre>/)
  assert.match(html, /No specific target was provided/)
})


test('historical multiline command summaries stay compact while expanded details retain the exact command', async () => {
  const { activityPresentation } = await import('../src/components/activityPresentation')
  const command = "python3 - <<'PY'\nprint('exact source')\nPY"
  const presentation = activityPresentation({ kind: 'command', title: command, detail: 'Exit code: 0' })
  assert.equal(presentation.title, "python3 - <<'PY'…")
  assert.equal(presentation.detail, `Command:\n${command}\n\nExit code: 0`)
  const html = renderToStaticMarkup(<ActivityRow activity={{ id: 'command', kind: 'command', title: command, detail: 'Exit code: 0', status: 'completed', startedAt: 1 }} onOpenFile={noop} onError={noop} />)
  assert.doesNotMatch(html, /exact source/)
  assert.match(html, /aria-expanded="false"/)
  const unicode = activityPresentation({ kind: 'command', title: '😀'.repeat(140), detail: 'Command: exact source already recorded' })
  assert.equal([...unicode.title].length, 100)
  assert.equal(unicode.detail, 'Command: exact source already recorded')
})


test('exact host tool labels describe actions while preserving failure details and unknown identifiers', async () => {
  const { activityPresentation } = await import('../src/components/activityPresentation')
  const detail = 'Error: access denied\n/path/from/output/must-not-be-inferred.txt\n{"path":"another.txt"}'
  for (const [name, label] of [['files_read', 'Read file'], ['akorith_files_read', 'Read file'], ['files_write', 'Write file'], ['files_search', 'Search files'], ['akorith_browser_open', 'Open browser']]) {
    assert.deepEqual(activityPresentation({ kind: 'tool', title: name, detail }), { title: label, detail })
  }
  for (const title of ['plugin_files_read', 'akorith_files_read_extra', 'akorith_akorith_files_read', 'files_read /tmp/a', 'constructor', '__proto__']) {
    assert.deepEqual(activityPresentation({ kind: 'tool', title, detail }), { title, detail })
  }
  const html = renderToStaticMarkup(<ActivityRow activity={{ id: 'failed-read', kind: 'tool', title: 'akorith_files_read', detail, status: 'failed', startedAt: 1 }} onOpenFile={noop} onError={noop} />)
  assert.match(html, /Read file/)
  assert.doesNotMatch(html, /Read file:|Read successfully|another\.txt/)
  assert.deepEqual(activityPresentation({ kind: 'command', title: 'files_read', detail }), { title: 'files_read', detail })
})
