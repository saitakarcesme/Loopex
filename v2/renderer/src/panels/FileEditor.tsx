import {
  ArrowLeft,
  Check,
  Copy,
  FileCode2,
  FolderOpen,
  Pencil,
  RefreshCw,
  Save,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Task } from '../../../shared/contracts'
import { api, basename, errorText, persist, remember } from '../api'
import { EmptyState, IconButton, Spinner } from '../components/Primitives'
import {
  acknowledgeEditorSave,
  compareEditor,
  fileDraft,
  hasFileDraft,
  openEditor,
  resolveEditor,
  type FileDraft,
  type FileEditorState,
  type OpenFile,
} from './fileEditorState'

export function FileEditor({
  task,
  file,
  onBack,
  onError,
}: {
  task: Task
  file: OpenFile
  onBack: () => void
  onError: (error: unknown) => void
}) {
  const draftKey = `fileDraft.${task.id}.${file.path}`
  const [editor, setEditor] = useState(() =>
    openEditor(file, remember<FileDraft | null>(draftKey, null)),
  )
  const current = useRef(editor)
  const alive = useRef(true)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [comparing, setComparing] = useState(false)
  const compareGeneration = useRef(0)
  const [failure, setFailure] = useState<string | null>(() =>
    editor.needsComparison
      ? 'The recovered draft uses an older disk version. Compare it before saving.'
      : null,
  )
  const [saved, setSaved] = useState(false)
  const [copied, setCopied] = useState(false)
  const [imageData, setImageData] = useState<string | null>(null)
  const [discard, setDiscard] = useState<'back' | 'finish' | 'reload' | null>(null)
  const dirty = hasFileDraft(editor)
  const { base, content, editing, disk } = editor

  const update = useCallback(
    (change: (state: FileEditorState) => FileEditorState) => {
      if (!alive.current) return
      const next = change(current.current)
      current.current = next
      setEditor(next)
      // Persist in the same input handler so switching tasks/closing immediately cannot lose typing.
      persist(draftKey, fileDraft(next))
    },
    [draftKey],
  )
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      compareGeneration.current++
    }
  }, [])
  useEffect(() => {
    if (!saved && !copied) return
    const timer = setTimeout(() => {
      setSaved(false)
      setCopied(false)
    }, 2000)
    return () => clearTimeout(timer)
  }, [saved, copied])
  useEffect(() => {
    setImageData(null)
    if (!base.binary || !/\.(png|jpe?g|gif|webp|avif)$/i.test(base.path)) return
    let disposed = false
    void api<{ dataUrl: string }>('files:media', { taskId: task.id, path: base.path })
      .then((result) => {
        if (!disposed) setImageData(result.dataUrl)
      })
      .catch((error) => {
        if (!disposed) onError(error)
      })
    return () => {
      disposed = true
    }
  }, [base.path, base.binary, base.hash, task.id, onError])

  const compare = async () => {
    if (saving.current) return
    const generation = ++compareGeneration.current
    setComparing(true)
    setFailure(null)
    try {
      const next = await api<OpenFile>('files:read', { taskId: task.id, path: base.path })
      if (!alive.current || generation !== compareGeneration.current) return
      update((state) => compareEditor(state, next))
    } catch (error) {
      if (alive.current && generation === compareGeneration.current) setFailure(errorText(error))
    } finally {
      if (alive.current && generation === compareGeneration.current) setComparing(false)
    }
  }
  const save = async () => {
    const state = current.current
    if (saving.current || comparing || state.disk || task.mode === 'read' || !hasFileDraft(state))
      return
    if (state.needsComparison || !state.base.hash || state.base.binary || state.base.truncated) {
      setFailure('Compare with the disk version before saving this draft.')
      return
    }
    saving.current = true
    setBusy(true)
    setFailure(null)
    const submitted = state.content
    try {
      const result = await api<{ ok: boolean; hash: string }>('files:write', {
        taskId: task.id,
        path: state.base.path,
        content: submitted,
        expectedHash: state.base.hash,
      })
      if (!alive.current) return
      update((latest) => acknowledgeEditorSave(latest, submitted, result.hash))
      setSaved(true)
    } catch (error) {
      if (!alive.current) return
      setFailure(errorText(error))
      update((latest) => ({ ...latest, needsComparison: true }))
    } finally {
      saving.current = false
      if (alive.current) setBusy(false)
    }
  }
  const resolve = (choice: 'reload' | 'keep-draft') => {
    if (saving.current || comparing || !current.current.disk) return
    update((state) => resolveEditor(state, choice))
    setFailure(null)
    setDiscard(null)
    setSaved(false)
  }
  const navigate = (action: 'back' | 'finish') => {
    if (dirty) setDiscard(action)
    else if (action === 'back') onBack()
    else update((state) => ({ ...state, editing: !state.editing }))
  }
  const copyDraft = async () => {
    try {
      await navigator.clipboard.writeText(current.current.content)
      if (alive.current) setCopied(true)
    } catch (error) {
      onError(error)
    }
  }
  const discardEdits = () => {
    if (discard === 'reload') {
      resolve('reload')
      return
    }
    const action = discard
    update((state) => ({
      ...state,
      content: state.base.content,
      editing: false,
      needsComparison: false,
      disk: null,
    }))
    setDiscard(null)
    if (action === 'back') onBack()
  }

  return (
    <div className="file-viewer">
      <div className="panel-toolbar">
        <IconButton label="Back to files" disabled={busy} onClick={() => navigate('back')}>
          <ArrowLeft size={15} />
        </IconButton>
        <FileCode2 size={14} />
        <span className="toolbar-filename" title={base.path}>
          {basename(base.path)}
          {dirty ? <span className="unsaved-dot" aria-label="Unsaved edits" /> : null}
        </span>
        <IconButton
          label="Reveal in Finder"
          onClick={() =>
            void api('app:reveal', { taskId: task.id, path: base.path }).catch(onError)
          }
        >
          <FolderOpen size={15} />
        </IconButton>
        <IconButton
          label="Compare with disk"
          disabled={busy || comparing}
          onClick={() => void compare()}
        >
          {comparing ? <Spinner size={14} /> : <RefreshCw size={14} />}
        </IconButton>
        {!base.binary && !base.truncated ? (
          <IconButton
            label={
              editing
                ? 'Finish editing'
                : task.mode === 'read'
                  ? 'Change task to Workspace access to edit files'
                  : 'Edit file'
            }
            disabled={busy || (task.mode === 'read' && !editing)}
            onClick={() => navigate('finish')}
          >
            {editing ? <Check size={15} /> : <Pencil size={15} />}
          </IconButton>
        ) : null}
        {editing ? (
          <button
            className="small-button"
            disabled={
              !dirty ||
              busy ||
              comparing ||
              !!disk ||
              editor.needsComparison ||
              task.mode === 'read'
            }
            onClick={() => void save()}
          >
            {busy ? <Spinner size={12} /> : saved ? <Check size={12} /> : <Save size={12} />}Save
          </button>
        ) : null}
      </div>
      <div className="file-path" title={base.path}>
        {base.path}
      </div>
      {failure ? (
        <div className="file-save-error" role="alert">
          <span>{failure}</span>
          <span>Your draft is preserved.</span>
          <button
            className="text-button"
            disabled={busy || comparing}
            onClick={() => void compare()}
          >
            Compare with disk
          </button>
        </div>
      ) : null}
      {discard ? (
        <div className="inline-confirm" role="alert">
          <span>
            {discard === 'reload'
              ? 'Reloading replaces your unsaved draft with the disk version shown below.'
              : 'You have unsaved edits.'}
          </span>
          <button className="small-button" onClick={discardEdits}>
            {discard === 'reload' ? 'Discard draft and reload' : 'Discard edits'}
          </button>
          <button className="text-button" onClick={() => setDiscard(null)}>
            Keep editing
          </button>
          <button className="text-button" onClick={() => void copyDraft()}>
            {copied ? 'Copied' : 'Copy draft'}
          </button>
        </div>
      ) : null}
      {disk ? (
        <div className="file-comparison-controls">
          <strong>Compare with disk</strong>
          <p>
            Your draft is unchanged. Merge the disk changes into your draft below, or reload the
            displayed disk version.
          </p>
          <div>
            <button
              className="small-button"
              disabled={comparing || busy}
              onClick={() => (dirty ? setDiscard('reload') : resolve('reload'))}
            >
              Reload from disk
            </button>
            <button
              className="small-button"
              disabled={
                comparing ||
                busy ||
                !!disk.binary ||
                disk.truncated ||
                !disk.hash ||
                task.mode === 'read'
              }
              onClick={() => resolve('keep-draft')}
            >
              Use my draft
            </button>
            <button className="text-button" onClick={() => void copyDraft()}>
              <Copy size={12} />
              {copied ? 'Copied' : 'Copy draft'}
            </button>
          </div>
          <small>
            “Use my draft” keeps your edits for the next Save, replacing the disk version shown
            here. Further disk changes are still protected.
          </small>
          <button
            className="text-button"
            onClick={() => {
              setDiscard(null)
              update((state) => ({ ...state, disk: null }))
            }}
          >
            Close comparison
          </button>
        </div>
      ) : null}
      <div className={disk ? 'file-comparison' : 'file-editor-surface'}>
        {disk ? (
          <section className="file-comparison-version" aria-label="Current disk contents">
            <div className="file-version-label">
              On disk{' '}
              <button className="text-button" disabled={comparing} onClick={() => void compare()}>
                {comparing ? 'Reading…' : 'Refresh'}
              </button>
            </div>
            {disk.binary ? (
              <p className="panel-footnote">This version is binary and cannot be merged here.</p>
            ) : (
              <pre className="file-content" tabIndex={0}>
                {disk.content}
              </pre>
            )}
            {disk.truncated ? (
              <p className="panel-footnote">Disk preview is truncated. Use my draft is disabled.</p>
            ) : null}
          </section>
        ) : null}
        <section
          className={disk ? 'file-comparison-version' : 'file-editor-surface'}
          aria-label={disk ? 'Your draft' : 'File contents'}
        >
          {disk ? <div className="file-version-label">Your draft</div> : null}
          {imageData && !editing ? (
            <div className="image-file-preview">
              <img src={imageData} alt={basename(base.path)} />
            </div>
          ) : base.binary && !editing ? (
            <EmptyState icon={<FileCode2 size={26} />} title="Binary file">
              <p>This file can be opened in its own application.</p>
            </EmptyState>
          ) : editing ? (
            <textarea
              className="file-editor"
              aria-label={`Edit ${basename(base.path)}`}
              spellCheck={false}
              value={content}
              onChange={(event) => update((state) => ({ ...state, content: event.target.value }))}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
                  event.preventDefault()
                  void save()
                }
                if (event.key === 'Tab') {
                  event.preventDefault()
                  const element = event.currentTarget,
                    start = element.selectionStart,
                    end = element.selectionEnd
                  update((state) => ({
                    ...state,
                    content: state.content.slice(0, start) + '  ' + state.content.slice(end),
                  }))
                  requestAnimationFrame(() => {
                    if (element.isConnected) element.setSelectionRange(start + 2, start + 2)
                  })
                }
              }}
            />
          ) : (
            <pre className="file-content">
              <code>{base.content}</code>
            </pre>
          )}
        </section>
      </div>
      {base.truncated ? (
        <div className="panel-footnote">
          Large file: this preview is truncated. Open it in an editor to view the full file.
        </div>
      ) : null}
      {saved ? (
        <div className="panel-footnote" role="status">
          {dirty ? 'Previous edits saved. Your newer edits are still unsaved.' : 'Saved to disk.'}
        </div>
      ) : null}
    </div>
  )
}
