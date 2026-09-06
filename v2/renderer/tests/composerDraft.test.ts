import assert from 'node:assert/strict'
import test from 'node:test'
import {
  acknowledgeComposerSubmission,
  beginComposerSubmission,
  restoreComposerDraft,
} from '../src/components/composerDraftState'

test('latest local typing survives restart before the debounced DB update', () => {
  const local = { ...restoreComposerDraft(null, 'old DB text'), text: 'latest typed text' }
  assert.equal(
    restoreComposerDraft(JSON.parse(JSON.stringify(local)), 'old DB text').text,
    'latest typed text',
  )
})

test('a successfully submitted empty draft never falls back to stale DB text', () => {
  const started = beginComposerSubmission(
    restoreComposerDraft(null, 'send this'),
    'send',
    'request-1',
  )
  const accepted = acknowledgeComposerSubmission(started, 'request-1')
  assert.equal(restoreComposerDraft(JSON.parse(JSON.stringify(accepted)), 'send this').text, '')
})

test('accepted-before-ack journal reconciles by request ID without automatic resend', () => {
  const started = beginComposerSubmission(
    restoreComposerDraft(null, 'send this'),
    'send',
    'request-1',
  )
  const reopened = restoreComposerDraft(JSON.parse(JSON.stringify(started)), 'send this')
  assert.equal(reopened.pending?.requestId, 'request-1')
  assert.equal(reopened.text, 'send this')
  assert.equal(acknowledgeComposerSubmission(reopened, 'request-1').text, '')
})

test('typing during send acknowledgement survives, and a stale acknowledgement cannot clear another send', () => {
  const started = beginComposerSubmission(
    restoreComposerDraft(null, 'first prompt'),
    'send',
    'first',
  )
  const typed = { ...started, text: 'follow-up draft' }
  assert.equal(acknowledgeComposerSubmission(typed, 'first').text, 'follow-up draft')
  const second = beginComposerSubmission(typed, 'send', 'second')
  assert.equal(acknowledgeComposerSubmission(second, 'first'), second)
})

test('retry of the same queued submission reuses its ID while changed text gets a new ID', () => {
  const first = beginComposerSubmission(restoreComposerDraft(null, 'prompt'), 'send', 'first')
  assert.equal(beginComposerSubmission(first, 'send', 'unused').pending?.requestId, 'first')
  assert.equal(
    beginComposerSubmission({ ...first, text: 'different' }, 'send', 'second').pending?.requestId,
    'second',
  )
})

test('uncertain guidance remains explicit in the recovery journal', () => {
  const pending = beginComposerSubmission(
    restoreComposerDraft(null, 'guide this run'),
    'steer',
    'guidance',
  )
  const recovered = restoreComposerDraft(JSON.parse(JSON.stringify(pending)), '')
  assert.equal(recovered.pending?.kind, 'steer')
  assert.equal(recovered.text, 'guide this run')
})
