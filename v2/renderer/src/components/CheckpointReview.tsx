import {
  ArrowUpRight,
  Check,
  CircleAlert,
  FileCode2,
  History,
  RefreshCw,
  RotateCcw,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { api, errorText } from '../api'
import { Dialog, EmptyState, IconButton, Spinner } from './Primitives'

interface CheckpointChange {
  path: string
  status: 'created' | 'modified' | 'deleted'
  undoneAt?: number
}
interface CheckpointSummary {
  taskId: string
  turnId: string
  complete: boolean
  changes: CheckpointChange[]
  warnings: string[]
}
interface CheckpointFile {
  change: CheckpointChange
  before: string | null
  after: string | null
}

function RecordedFile({ label, content }: { label: string; content: string | null }) {
  return (
    <section className="checkpoint-version" aria-label={label}>
      <div className="checkpoint-version-heading">{label}</div>
      {content === null ? (
        <div className="checkpoint-no-file">File did not exist</div>
      ) : content === '' ? (
        <div className="checkpoint-no-file">Empty file</div>
      ) : (
        <pre tabIndex={0}>{content}</pre>
      )}
    </section>
  )
}

export function CheckpointReview({
  taskId,
  turnId,
  undoBlockReason,
  onOpenFile,
  onOverlay,
}: {
  taskId: string
  turnId: string
  undoBlockReason: string | null
  onOpenFile: (path: string) => void
  onOverlay: (open: boolean) => void
}) {
  const [summary, setSummary] = useState<CheckpointSummary | null>(null)
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [file, setFile] = useState<CheckpointFile | null>(null)
  const [loadingFile, setLoadingFile] = useState(false)
  const [undoing, setUndoing] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [summaryFailure, setSummaryFailure] = useState<string | null>(null)
  const stateRef = useRef({ open: false, loaded: false, complete: false })
  stateRef.current.open = open
  const readGeneration = useRef(0)
  const change = summary?.changes.find((change) => change.path === selected)
  const selectedFile = file?.change.path === selected ? file : null

  const refresh = useCallback(async () => {
    try {
      const next = await api<CheckpointSummary | null>('checkpoints:list', { taskId, turnId })
      setSummary(next)
      setSummaryFailure(null)
      stateRef.current.loaded = true
      stateRef.current.complete = next === null || next.complete
      return next
    } catch (error) {
      setSummaryFailure(errorText(error))
      return null
    }
  }, [taskId, turnId])

  useEffect(() => {
    void refresh()
    return window.akorith.onEvent((event) => {
      if (
        event.type === 'changed' &&
        event.taskId === taskId &&
        (stateRef.current.open || !stateRef.current.loaded || !stateRef.current.complete)
      )
        void refresh()
    })
  }, [refresh, taskId])
  useLayoutEffect(() => {
    if (!open) return
    onOverlay(true)
    return () => onOverlay(false)
  }, [open, onOverlay])
  useEffect(() => {
    if (!open || !selected) return
    const generation = ++readGeneration.current
    setLoadingFile(true)
    setFailure(null)
    setFile(null)
    void api<CheckpointFile>('checkpoints:read', { taskId, turnId, path: selected })
      .then((next) => {
        if (generation === readGeneration.current) setFile(next)
      })
      .catch((error) => {
        if (generation === readGeneration.current) setFailure(errorText(error))
      })
      .finally(() => {
        if (generation === readGeneration.current) setLoadingFile(false)
      })
    return () => {
      readGeneration.current++
    }
  }, [open, selected, taskId, turnId])

  const inspect = () => {
    setSelected((current) => current || summary?.changes[0]?.path || null)
    setOpen(true)
  }
  const undo = async () => {
    if (!selected || !selectedFile || loadingFile || undoing || undoBlockReason || change?.undoneAt)
      return
    setUndoing(true)
    setFailure(null)
    try {
      await api('checkpoints:undo', { taskId, turnId, path: selected })
      await refresh()
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setUndoing(false)
    }
  }
  const reviewInPanel = () => {
    if (!selected) return
    setOpen(false)
    onOpenFile(selected)
  }

  if (!summaryFailure && (!summary || (!summary.changes.length && !summary.warnings.length)))
    return null
  return (
    <>
      <button
        className="checkpoint-review-trigger"
        onClick={inspect}
        title={summaryFailure || undefined}
      >
        <History size={12} />
        {summary?.changes.length
          ? `Review ${summary.changes.length} changed file${summary.changes.length === 1 ? '' : 's'}`
          : summaryFailure
            ? 'File review unavailable'
            : 'Checkpoint notes'}
        {summary?.changes.some((change) => change.undoneAt) ? (
          <span>{summary.changes.filter((change) => change.undoneAt).length} undone</span>
        ) : null}
      </button>
      {open ? (
        <Dialog
          title="Changes from this turn"
          onClose={() => setOpen(false)}
          className="checkpoint-dialog"
        >
          {summaryFailure ? (
            <div className="panel-error">
              {summaryFailure}
              <button className="text-button" onClick={() => void refresh()}>
                Try again
              </button>
            </div>
          ) : null}
          {summary?.warnings.length || (summary && !summary.complete) ? (
            <details className="checkpoint-warnings">
              <summary>
                <CircleAlert size={13} />
                {!summary.complete
                  ? 'This checkpoint is incomplete'
                  : `${summary.warnings.length} checkpoint note${summary.warnings.length === 1 ? '' : 's'}`}
              </summary>
              {summary.warnings.length ? (
                <ul>
                  {summary.warnings.map((warning, index) => (
                    <li key={index}>{warning}</li>
                  ))}
                </ul>
              ) : (
                <p>Only the files recorded below can be restored.</p>
              )}
            </details>
          ) : null}
          <div className="checkpoint-layout">
            <nav className="checkpoint-files" aria-label="Files changed in this turn">
              <div className="checkpoint-files-heading">
                <span>{summary?.changes.length || 0} changed files</span>
                <IconButton label="Refresh recorded changes" onClick={() => void refresh()}>
                  <RefreshCw size={12} />
                </IconButton>
              </div>
              {summary?.changes.map((item) => (
                <button
                  key={item.path}
                  className={`checkpoint-file ${item.path === selected ? 'selected' : ''}`}
                  onClick={() => setSelected(item.path)}
                  title={item.path}
                >
                  <span
                    className={`git-status ${item.status === 'created' ? 'added' : item.status === 'deleted' ? 'removed' : ''}`}
                  >
                    {item.status === 'created' ? 'A' : item.status === 'deleted' ? 'D' : 'M'}
                  </span>
                  <span>{item.path}</span>
                  {item.undoneAt ? <Check size={12} aria-label="Undone" /> : null}
                </button>
              ))}
            </nav>
            <div className="checkpoint-detail">
              {change ? (
                <div className="checkpoint-file-toolbar">
                  <span title={change.path}>{change.path}</span>
                  <IconButton label="Open file in workspace panel" onClick={reviewInPanel}>
                    <ArrowUpRight size={14} />
                  </IconButton>
                  {change.undoneAt ? (
                    <span className="checkpoint-undone" role="status">
                      <Check size={13} />
                      Undone
                    </span>
                  ) : (
                    <button
                      className="small-button"
                      disabled={undoing || !!undoBlockReason || !selectedFile || loadingFile}
                      title={
                        undoBlockReason ||
                        (change.status === 'created'
                          ? 'Remove the file created by this turn'
                          : 'Restore this file to its state before the turn')
                      }
                      onClick={() => void undo()}
                    >
                      {undoing ? <Spinner size={12} /> : <RotateCcw size={12} />}Undo file
                    </button>
                  )}
                </div>
              ) : null}
              {failure ? (
                <div className="panel-error" role="alert">
                  {failure}
                </div>
              ) : null}
              {loadingFile ? (
                <div className="checkpoint-loading">
                  <Spinner size={18} />
                  <span>Loading recorded contents…</span>
                </div>
              ) : selectedFile && change ? (
                <div className="checkpoint-versions">
                  <RecordedFile label="Before this turn" content={selectedFile.before} />
                  <RecordedFile label="After this turn" content={selectedFile.after} />
                </div>
              ) : !failure ? (
                <EmptyState icon={<FileCode2 size={25} />} title="Choose a file">
                  <p>Review the recorded contents from this turn.</p>
                </EmptyState>
              ) : null}
              {change && !change.undoneAt ? (
                <div className="checkpoint-undo-note">
                  {undoBlockReason ||
                    (change.status === 'created'
                      ? 'Undo removes this file if it still matches the recorded version.'
                      : 'Undo restores the previous version if the file still matches this turn.')}
                </div>
              ) : change?.undoneAt ? (
                <div className="checkpoint-undo-note">
                  This file was restored. The recorded before and after contents remain available
                  for review.
                </div>
              ) : null}
            </div>
          </div>
        </Dialog>
      ) : null}
    </>
  )
}
