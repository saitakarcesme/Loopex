import { errorText } from '../api'

export interface ArtifactPreviewTarget {
  path: string
  name: string
  mimeType?: string
  kind: 'attachment' | 'image'
}
export type ArtifactPreviewState =
  | { status: 'loading' }
  | { status: 'ready'; dataUrl: string; mimeType: string }
  | { status: 'unavailable'; message: string; retryable: boolean }

type MediaReader = (
  command: 'files:media',
  payload: { taskId: string; path: string },
) => Promise<{ dataUrl: string; mimeType: string }>

export async function readArtifactPreview(
  taskId: string,
  target: ArtifactPreviewTarget,
  read: MediaReader,
): Promise<ArtifactPreviewState> {
  const image =
    target.kind === 'image' ||
    target.mimeType?.startsWith('image/') ||
    /\.(png|jpe?g|gif|webp|avif)$/i.test(target.path)
  if (!image)
    return {
      status: 'unavailable',
      message:
        'This file type does not have an in-app preview. The attachment remains available to this task. Open the original file in its own application to view it.',
      retryable: false,
    }
  try {
    // The host authorizes the path against this task's workspace and read-only roots.
    // An attachment path never falls back to files:read/write or app:reveal.
    const result = await read('files:media', { taskId, path: target.path })
    if (
      !/^image\/(png|jpeg|gif|webp|avif)$/.test(result.mimeType) ||
      !result.dataUrl.startsWith(`data:${result.mimeType};base64,`)
    )
      throw new Error('The file did not return a supported image preview.')
    return { status: 'ready', ...result }
  } catch (error) {
    return { status: 'unavailable', message: errorText(error), retryable: true }
  }
}
