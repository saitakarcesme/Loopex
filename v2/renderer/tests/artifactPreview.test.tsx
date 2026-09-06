import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ArtifactPreviewContent,
  ArtifactPreviewProvider,
  AttachmentLink,
} from '../src/components/ArtifactPreview'
import { readArtifactPreview } from '../src/components/artifactPreviewState'

const image = {
  id: 'picture',
  path: '/user-data/attachments/task-a/picture.png',
  name: 'Türkçe picture.png',
  mimeType: 'image/png',
  size: 150,
  kind: 'attachment' as const,
}
const result = { dataUrl: 'data:image/png;base64,aW1hZ2U=', mimeType: 'image/png' }
const noop = () => {}

test('image attachments request only scoped read-only media with the unchanged path', async () => {
  const calls: unknown[] = []
  const state = await readArtifactPreview('task-a', image, async (command, payload) => {
    calls.push({ command, payload })
    return result
  })
  assert.deepEqual(calls, [
    { command: 'files:media', payload: { taskId: 'task-a', path: image.path } },
  ])
  assert.deepEqual(state, { status: 'ready', ...result })
})

test('host containment errors stay errors without editor, reveal, or another-task fallback', async () => {
  const calls: unknown[] = []
  const state = await readArtifactPreview('task-b', image, async (command, payload) => {
    calls.push({ command, payload })
    throw new Error('Path is outside the selected workspace.')
  })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    command: 'files:media',
    payload: { taskId: 'task-b', path: image.path },
  })
  assert.deepEqual(state, {
    status: 'unavailable',
    message: 'Path is outside the selected workspace.',
    retryable: true,
  })
})

test('PDF and audio attachments show honest unsupported previews without reading or launching them', async () => {
  for (const [path, mimeType] of [
    ['/fixture/report.pdf', 'application/pdf'],
    ['/fixture/audio.wav', 'audio/wav'],
  ]) {
    let calls = 0
    const state = await readArtifactPreview('task-a', { ...image, path, mimeType }, async () => {
      calls++
      return result
    })
    assert.equal(calls, 0)
    assert.equal(state.status, 'unavailable')
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent state={state} name={path} onRetry={noop} />,
    )
    assert.match(html, /does not have an in-app preview/)
    assert.doesNotMatch(html, /<img|<audio|<iframe|<button|<textarea/)
  }
})

test('GIF with generic picker MIME still uses the host image signature check', async () => {
  let called = false
  const state = await readArtifactPreview(
    'task-a',
    { ...image, path: '/fixture/image.GIF', mimeType: 'application/octet-stream' },
    async () => {
      called = true
      return { dataUrl: 'data:image/gif;base64,Z2lm', mimeType: 'image/gif' }
    },
  )
  assert.equal(called, true)
  assert.equal(state.status, 'ready')
})

test('unsupported active or mismatched image content never becomes an image surface', async () => {
  for (const response of [
    { dataUrl: 'data:image/svg+xml;base64,c3Zn', mimeType: 'image/svg+xml' },
    { dataUrl: 'https://example.invalid/picture.png', mimeType: 'image/png' },
    { dataUrl: 'data:image/gif;base64,Z2lm', mimeType: 'image/png' },
  ]) {
    const state = await readArtifactPreview('task-a', image, async () => response)
    assert.equal(state.status, 'unavailable')
  }
})

test('image preview is read-only and attachment labels are reachable without exposing local paths', () => {
  const preview = renderToStaticMarkup(
    <ArtifactPreviewContent state={{ status: 'ready', ...result }} name={image.name} onRetry={noop} />,
  )
  assert.match(preview, /alt="Türkçe picture.png"/)
  assert.doesNotMatch(preview, /<button|<input|<textarea|Save|Reveal/)
  const link = renderToStaticMarkup(
    <ArtifactPreviewProvider taskId="task-a" onOverlay={noop}>
      <AttachmentLink attachment={image} />
    </ArtifactPreviewProvider>,
  )
  assert.match(link, /title="Preview Türkçe picture.png"/)
  assert.doesNotMatch(link, /disabled|user-data\/attachments/)
})
