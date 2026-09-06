import { File, ImageOff } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type PropsWithChildren,
} from 'react'
import type { Attachment } from '../../../shared/contracts'
import { api } from '../api'
import { Dialog, EmptyState, Spinner } from './Primitives'
import {
  readArtifactPreview,
  type ArtifactPreviewState,
  type ArtifactPreviewTarget,
} from './artifactPreviewState'

const ArtifactPreviewContext = createContext<((target: ArtifactPreviewTarget) => void) | null>(
  null,
)
export const useArtifactPreview = () => useContext(ArtifactPreviewContext)

export function AttachmentLink({ attachment }: { attachment: Attachment }) {
  const preview = useArtifactPreview()
  return (
    <button
      type="button"
      className="attachment-open"
      title={`Preview ${attachment.name}`}
      aria-label={`Preview ${attachment.name}`}
      disabled={!preview}
      onClick={() => preview?.({ ...attachment, kind: 'attachment' })}
    >
      <File size={13} />
      <span>{attachment.name}</span>
    </button>
  )
}

export function ArtifactPreviewContent({
  state,
  name,
  onRetry,
  onImageError,
}: {
  state: ArtifactPreviewState
  name: string
  onRetry: () => void
  onImageError?: () => void
}) {
  if (state.status === 'loading')
    return (
      <div className="artifact-preview-loading" role="status">
        <Spinner size={18} /> Loading preview…
      </div>
    )
  if (state.status === 'unavailable')
    return (
      <EmptyState
        icon={<ImageOff size={26} />}
        title="Preview unavailable"
        action={
          state.retryable ? (
            <button className="secondary-button" onClick={onRetry}>
              Try again
            </button>
          ) : undefined
        }
      >
        <p role="status">{state.message}</p>
      </EmptyState>
    )
  return (
    <img
      src={state.dataUrl}
      alt={name}
      className="artifact-preview-image"
      onError={onImageError}
    />
  )
}

function ArtifactPreviewDialog({
  taskId,
  target,
  onClose,
  onOverlay,
}: {
  taskId: string
  target: ArtifactPreviewTarget
  onClose: () => void
  onOverlay: (open: boolean) => void
}) {
  const [state, setState] = useState<ArtifactPreviewState>({ status: 'loading' })
  const [attempt, setAttempt] = useState(0)
  useLayoutEffect(() => {
    onOverlay(true)
    return () => onOverlay(false)
  }, [onOverlay])
  useEffect(() => {
    let disposed = false
    setState({ status: 'loading' })
    void readArtifactPreview(taskId, target, api).then((result) => {
      if (!disposed) setState(result)
    })
    return () => {
      disposed = true
    }
  }, [taskId, target, attempt])
  return (
    <Dialog title={target.name} onClose={onClose} className="artifact-preview-dialog">
      <div className="artifact-preview-meta">
        <span>{target.kind === 'attachment' ? 'Task attachment' : 'Task image'}</span>
        <span>Read-only preview</span>
      </div>
      <div className="artifact-preview-body">
        <ArtifactPreviewContent
          state={state}
          name={target.name}
          onRetry={() => setAttempt((value) => value + 1)}
          onImageError={() =>
            setState({
              status: 'unavailable',
              message: 'This image could not be displayed. Its contents may be damaged or unsupported.',
              retryable: true,
            })
          }
        />
      </div>
    </Dialog>
  )
}

export function ArtifactPreviewProvider({
  taskId,
  onOverlay,
  children,
}: PropsWithChildren<{ taskId: string | null; onOverlay: (open: boolean) => void }>) {
  const [target, setTarget] = useState<ArtifactPreviewTarget | null>(null)
  const open = useCallback((next: ArtifactPreviewTarget) => setTarget(next), [])
  const close = useCallback(() => setTarget(null), [])
  return (
    <ArtifactPreviewContext.Provider value={taskId ? open : null}>
      {children}
      {target && taskId ? (
        <ArtifactPreviewDialog
          key={target.path}
          taskId={taskId}
          target={target}
          onClose={close}
          onOverlay={onOverlay}
        />
      ) : null}
    </ArtifactPreviewContext.Provider>
  )
}
