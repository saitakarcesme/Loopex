import { Check, GitBranch, GitCompareArrows, Minus, Plus, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { GitStatus, Task } from '../../../shared/contracts'
import { api, errorText } from '../api'
import { EmptyState, IconButton, Spinner } from '../components/Primitives'

export function DiffPanel({
  task,
  visible,
  onError,
}: {
  task: Task
  visible: boolean
  onError: (error: unknown) => void
}) {
  const [status, setStatus] = useState<GitStatus | null>(null)
  const [path, setPath] = useState('')
  const [diff, setDiff] = useState('')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    setLoading(true)
    setFailure(null)
    try {
      const [nextStatus, nextDiff] = await Promise.all([
        api<GitStatus>('git:status', { taskId: task.id }),
        api<{ diff: string }>('git:diff', { taskId: task.id, path: path || undefined }),
      ])
      setStatus(nextStatus)
      setDiff(nextDiff.diff)
    } catch (error) {
      setFailure(errorText(error))
    } finally {
      setLoading(false)
    }
  }, [task.id, path])
  useEffect(() => {
    if (visible) void refresh()
  }, [refresh, visible, task.status])
  const stage = async (filePath: string, staged: boolean) => {
    try {
      await api('git:stage', { taskId: task.id, path: filePath, staged })
      await refresh()
    } catch (error) {
      onError(error)
    }
  }
  return (
    <div className="diff-panel">
      <div className="panel-toolbar">
        <GitBranch size={14} />
        <span className="toolbar-filename">{status?.branch || 'Changes'}</span>
        <span className="muted small">{status?.files.length || 0} files</span>
        <IconButton label="Refresh changes" disabled={loading} onClick={() => void refresh()}>
          {loading ? <Spinner /> : <RefreshCw size={14} />}
        </IconButton>
      </div>
      {failure ? (
        <div className="panel-error">
          {failure}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : status && !status.isRepo ? (
        <EmptyState icon={<GitBranch size={26} />} title="No Git repository">
          <p>Open a project with Git to review file changes here.</p>
        </EmptyState>
      ) : status && !status.files.length ? (
        <EmptyState icon={<Check size={26} />} title="No uncommitted changes">
          <p>Changes made in this project will appear here.</p>
        </EmptyState>
      ) : (
        <>
          <div className="changed-files">
            <button
              className={`changed-file ${!path ? 'selected' : ''}`}
              onClick={() => setPath('')}
            >
              <GitCompareArrows size={14} />
              <span>All changes</span>
              <span className="muted">{status?.files.length}</span>
            </button>
            {status?.files.map((file) => {
              const staged = !!file.status[0] && file.status[0] !== ' ' && file.status[0] !== '?'
              return (
                <div
                  key={file.path}
                  className={`changed-file ${path === file.path ? 'selected' : ''}`}
                >
                  <button className="changed-file-name" onClick={() => setPath(file.path)}>
                    <span
                      className={`git-status ${file.status.includes('?') || file.status.includes('A') ? 'added' : file.status.includes('D') ? 'removed' : ''}`}
                    >
                      {file.status.trim() || 'M'}
                    </span>
                    <span>{file.path}</span>
                  </button>
                  {file.additions !== undefined ? (
                    <small className="diff-added">+{file.additions}</small>
                  ) : null}
                  {file.deletions !== undefined ? (
                    <small className="diff-removed">−{file.deletions}</small>
                  ) : null}
                  <IconButton
                    label={staged ? `Unstage ${file.path}` : `Stage ${file.path}`}
                    disabled={task.mode === 'read'}
                    onClick={() => void stage(file.path, !staged)}
                  >
                    {staged ? <Minus size={13} /> : <Plus size={13} />}
                  </IconButton>
                </div>
              )
            })}
          </div>
          <div className="diff-content">
            {diff ? (
              <pre>
                {diff.split('\n').map((line, index) => (
                  <div
                    key={index}
                    className={`diff-line ${line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'diff-header' : line.startsWith('+') ? 'addition' : line.startsWith('-') ? 'deletion' : line.startsWith('@@') ? 'diff-hunk' : ''}`}
                  >
                    <span className="diff-line-number">{index + 1}</span>
                    <code>{line || ' '}</code>
                  </div>
                ))}
              </pre>
            ) : !loading ? (
              <div className="diff-unavailable">
                No text diff for this selection. New and binary files may not have a patch yet.
              </div>
            ) : null}
          </div>
        </>
      )}
    </div>
  )
}
