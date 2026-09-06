import assert from 'node:assert/strict'
import test from 'node:test'
import { boundedCapture, capturePng, MAX_CAPTURE_BYTES } from '../../main/host/browser-capture'

test('capture cancellation is checked before dispatch and late images cannot become success', async () => {
  const before = new AbortController(); before.abort()
  let dispatched = false
  await assert.rejects(boundedCapture(async () => { dispatched = true; return 'image' }, before.signal), /cancelled/)
  assert.equal(dispatched, false)
  const during = new AbortController()
  let release!: (value: string) => void
  const result = boundedCapture(() => new Promise<string>(resolve => { release = resolve }), during.signal)
  await Promise.resolve()
  during.abort()
  await assert.rejects(result, /cancelled/)
  release('late image')
})

test('unresponsive capture reports a finite deadline without retrying', async () => {
  let attempts = 0
  await assert.rejects(boundedCapture(() => { attempts++; return new Promise(() => {}) }, new AbortController().signal, 10), /timed out/)
  assert.equal(attempts, 1)
})

test('PNG admission rejects empty, malformed, excessive byte and excessive dimension output', () => {
  assert.throws(() => capturePng(''), /invalid/)
  assert.throws(() => capturePng('not a png'), /invalid/)
  assert.throws(() => capturePng('A'.repeat(Math.ceil(MAX_CAPTURE_BYTES / 3) * 4 + 4)), /oversized/)
  const header = Buffer.alloc(24)
  Buffer.from([137,80,78,71,13,10,26,10]).copy(header)
  header.writeUInt32BE(20000, 16); header.writeUInt32BE(20000, 20)
  assert.throws(() => capturePng(header.toString('base64')), /dimensions/)
  header.writeUInt32BE(0, 16)
  assert.throws(() => capturePng(header.toString('base64')), /dimensions/)
})
