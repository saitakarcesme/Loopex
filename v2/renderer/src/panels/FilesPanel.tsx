import { ArrowLeft, ChevronRight, FileCode2, Folder, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { FileEntry, Task } from '../../../shared/contracts'
import { api, basename, errorText } from '../api'
import { EmptyState, IconButton, Spinner } from '../components/Primitives'
import { FileEditor } from './FileEditor'
import type { OpenFile } from './fileEditorState'

export function FilesPanel({
  task,
  requestedPath,
  requestVersion,
  onError,
}: {
  task: Task
  requestedPath?: string
  requestVersion?: number
  onError: (error: unknown) => void
}) {
  const [directory, setDirectory] = useState('')
  const [history, setHistory] = useState<string[]>([])
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [file, setFile] = useState<{ value: OpenFile; generation: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const readGeneration = useRef(0)
  const refresh = useCallback(async () => {
    const generation = ++readGeneration.current
    setLoading(true)
    setFailure(null)
    try {
      const result = await api<FileEntry[]>('files:list', {
        taskId: task.id,
        path: directory || undefined,
      })
      if (generation === readGeneration.current) setEntries(result)
    } catch (error) {
      if (generation === readGeneration.current) setFailure(errorText(error))
    } finally {
      if (generation === readGeneration.current) setLoading(false)
    }
  }, [task.id, directory])
  useEffect(() => {
    void refresh()
    return () => {
      readGeneration.current++
    }
  }, [refresh])
  const openFile = useCallback(
    async (path: string) => {
      const generation = ++readGeneration.current
      setLoading(true)
      setFailure(null)
      try {
        const result = await api<OpenFile>('files:read', { taskId: task.id, path })
        if (generation === readGeneration.current) setFile({ value: result, generation })
      } catch (error) {
        if (generation === readGeneration.current) onError(error)
      } finally {
        if (generation === readGeneration.current) setLoading(false)
      }
    },
    [task.id, onError],
  )
  useEffect(() => {
    if (requestedPath) void openFile(requestedPath)
  }, [requestedPath, requestVersion, openFile])
  if (file)
    return (
      <FileEditor
        key={file.generation}
        task={task}
        file={file.value}
        onBack={() => setFile(null)}
        onError={onError}
      />
    )
  return (
    <div className="files-panel">
      <div className="panel-toolbar">
        <IconButton
          label="Parent folder"
          disabled={!history.length}
          onClick={() => {
            setDirectory(history.at(-1)!)
            setHistory((current) => current.slice(0, -1))
          }}
        >
          <ArrowLeft size={15} />
        </IconButton>
        <span className="toolbar-filename" title={directory}>
          {directory ? basename(directory) : 'Workspace files'}
        </span>
        <IconButton label="Refresh files" disabled={loading} onClick={() => void refresh()}>
          {loading ? <Spinner /> : <RefreshCw size={14} />}
        </IconButton>
      </div>
      <div className="file-filter">
        <input
          aria-label="Filter files in this folder"
          placeholder="Filter this folder…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      {failure ? (
        <div className="panel-error">
          {failure}
          <button className="text-button" onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      ) : (
        <div className="file-list">
          {entries
            .filter((entry) => entry.name.toLowerCase().includes(filter.toLowerCase()))
            .sort(
              (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name),
            )
            .map((entry) => (
              <button
                key={entry.path}
                className="file-row"
                onClick={() => {
                  if (entry.directory) {
                    setHistory((current) => [...current, directory])
                    setDirectory(entry.path)
                    setFilter('')
                  } else void openFile(entry.path)
                }}
              >
                {entry.directory ? <Folder size={16} /> : <FileCode2 size={16} />}
                <span>{entry.name}</span>
                {entry.directory ? (
                  <ChevronRight size={13} />
                ) : entry.size !== undefined ? (
                  <small>
                    {entry.size > 1024 ? `${Math.round(entry.size / 1024)} KB` : `${entry.size} B`}
                  </small>
                ) : null}
              </button>
            ))}
          {!entries.length && !loading ? (
            <EmptyState icon={<Folder size={26} />} title="This folder is empty">
              <p>Files created by your task will appear here.</p>
            </EmptyState>
          ) : null}
        </div>
      )}
    </div>
  )
}
