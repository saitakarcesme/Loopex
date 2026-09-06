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
