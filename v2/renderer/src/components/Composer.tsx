import { ArrowUp, ChevronDown, Folder, Plus, ShieldAlert, ShieldCheck, Square, X } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Attachment, PermissionMode, ProviderInfo, Task } from '../../../shared/contracts'
import { api, isActive } from '../api'
import { useComposerDraft } from '../hooks/useComposerDraft'
import { AttachmentLink } from './ArtifactPreview'
import { acknowledgeComposerSubmission, beginComposerSubmission } from './composerDraftState'
import { IconButton, Spinner } from './Primitives'
import { CompactChoice } from './CompactChoice'
import { ModelPicker } from './ModelPicker'
import { modelSelectionPatch } from './modelPickerState'
import { Queue } from './Queue'
import type { ProjectFileChoice } from '../../../shared/project-files'
import { FileMentionMenu } from './FileMentionMenu'
import { fileMentionAt, insertFileMention, mentionKey, currentMentionFiles, type FileMention } from './fileMentionState'

interface ComposerProps {
  task: Task
  projectName?: string
  onChooseProject?: () => void
  providers: ProviderInfo[]
  onPatch: (patch: Partial<Task>) => Promise<unknown>
  onSent: () => void
  onError: (error: unknown) => void
  onConnections: () => void
  onModelOverlay: (open: boolean) => void
  suggestion?: { id: string; text: string } | null
}
export function Composer({
  task,
  projectName,
  onChooseProject,
  providers,
  onPatch,
  onSent,
  onError,
  onConnections,
  onModelOverlay,
  suggestion,
}: ComposerProps) {
  const { draft: localDraft, update: updateLocalDraft } = useComposerDraft(
    task.id,
    task.draft,
    onError,
  )
  const { text: draft, attachments } = localDraft
  const [selectingModel, setSelectingModel] = useState(false)
  const selectingModelRef = useRef(false)
  const [sending, setSending] = useState(false)
  const [attaching, setAttaching] = useState(false)
  const attachingRef = useRef(false)
  const [mention, setMention] = useState<FileMention | null>(null)
  const [mentionResult, setMentionResult] = useState<{query:string;start:number;files:ProjectFileChoice[]} | null>(null)
  const mentionFiles = currentMentionFiles(mention, mentionResult)
  const mentionCaret = useRef<number | null>(null)
  const [mentionIndex, setMentionIndex] = useState(0)
  const [mentionLoading, setMentionLoading] = useState(false)
  const [mentionError, setMentionError] = useState('')
  const [stopping, setStopping] = useState(false)
  const [sendMode, setSendMode] = useState<'queue' | 'steer'>('queue')
  const textarea = useRef<HTMLTextAreaElement>(null)
  const draftRef = useRef(draft)
  draftRef.current = draft
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const lastSaved = useRef(task.draft)
  const sendingRef = useRef(false)
  const errorRef = useRef(onError)
  errorRef.current = onError
  const active = isActive(task.status)
  const provider = providers.find((item) => item.id === task.providerId)
  const model = provider?.models.find((item) => item.id === task.model)
  const available = !!provider?.available && provider.authenticated !== false && !!model
  const allowSteer = !!provider?.capabilities.steer
  useEffect(() => {
    if (suggestion) {
      const next = updateLocalDraft((current) => ({ ...current, text: suggestion.text }))
      draftRef.current = next.text
      textarea.current?.focus()
    }
  }, [suggestion, updateLocalDraft])
  useEffect(() => {
    clearTimeout(saveTimer.current)
    if (draft === lastSaved.current) return
    saveTimer.current = setTimeout(() => {
      const value = draftRef.current
      void api<Task>('task:update', { taskId: task.id, patch: { draft: value } })
        .then(() => {
          lastSaved.current = value
        })
        .catch(errorRef.current)
    }, 350)
    return () => clearTimeout(saveTimer.current)
  }, [draft, task.id])
  useEffect(
    () => () => {
      clearTimeout(saveTimer.current)
      if (draftRef.current !== lastSaved.current)
        void api('task:update', { taskId: task.id, patch: { draft: draftRef.current } }).catch(
          errorRef.current,
        )
    },
    [task.id],
  )
  useLayoutEffect(() => {
    const element = textarea.current
    if (element) {
      element.style.height = '0px'
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`
      if (mentionCaret.current !== null) { element.setSelectionRange(mentionCaret.current, mentionCaret.current); mentionCaret.current = null }
    }
  }, [draft])
  useEffect(() => {
    if (!active) setStopping(false)
  }, [active])
  useEffect(() => {
    const pending = localDraft.pending
    if (!pending || pending.kind !== 'send' || sending) return
    let disposed = false
    void api<{ accepted: boolean }>('task:submissionStatus', {
      taskId: task.id,
      requestId: pending.requestId,
    })
      .then((result) => {
        if (disposed || !result.accepted) return
        const next = updateLocalDraft((current) =>
          acknowledgeComposerSubmission(current, pending.requestId),
        )
        draftRef.current = next.text
        void api<Task>('task:update', { taskId: task.id, patch: { draft: next.text } })
          .then(() => {
            lastSaved.current = next.text
          })
          .catch(errorRef.current)
      })
      .catch(errorRef.current)
    return () => {
      disposed = true
    }
  }, [localDraft.pending, sending, task.id, updateLocalDraft])
  useEffect(() => {
    setMentionResult(null); setMentionIndex(0); setMentionError('')
    if (!mention || !task.projectId) return
    let disposed = false
    setMentionLoading(true)
    const timer = setTimeout(() => {
      void api<ProjectFileChoice[]>('projectFiles:search', { taskId:task.id, query:mention.query })
        .then(files => { if (!disposed) setMentionResult({query:mention.query,start:mention.start,files}) })
        .catch(() => { if (!disposed) setMentionError('Project files could not be searched. Try again.') })
        .finally(() => { if (!disposed) setMentionLoading(false) })
    }, 120)
    return () => { disposed = true; clearTimeout(timer) }
  }, [mention?.query, mention?.start, task.id, task.projectId])
  const trackMention = (text: string, caret: number) => {
    setMention(task.projectId && !(active && sendMode === 'steer') && !attachingRef.current ? fileMentionAt(text, caret) : null)
  }
  const chooseMention = async (file: ProjectFileChoice) => {
    if (!mention || attachingRef.current || sendingRef.current || (active && sendMode === 'steer') || !mentionFiles.some(item=>item.path===file.path)) return
    if (attachments.length >= 20) { onError(new Error('A message can contain at most 20 attachments.')); return }
    const selected = mention, original = draftRef.current
    attachingRef.current = true; setAttaching(true); setMention(null)
    try {
      const attachment = await api<Attachment>('projectFiles:attach', { taskId:task.id, path:file.path })
      const next = updateLocalDraft(current => {
        const inserted = current.text === original ? insertFileMention(current.text, selected, file.path) : null
        mentionCaret.current = inserted?.caret ?? null
        return { ...current, attachments:[...current.attachments, attachment], text:inserted?.text ?? current.text }
      })
      draftRef.current = next.text
      textarea.current?.focus()
    } catch (error) { onError(error) }
    finally { attachingRef.current = false; setAttaching(false) }
  }
  const submit = async () => {
    if (
      !draftRef.current.trim() ||
      sendingRef.current ||
      attachingRef.current ||
      selectingModelRef.current ||
      !available ||
      localDraft.pending?.kind === 'steer'
    )
      return
    const kind = active && sendMode === 'steer' && allowSteer ? 'steer' : 'send'
    sendingRef.current = true
    setSending(true)
    clearTimeout(saveTimer.current)
    const journal = updateLocalDraft((current) =>
      beginComposerSubmission(current, kind, crypto.randomUUID()),
    )
    const submitted = journal.pending!
    try {
      if (kind === 'steer')
        await api('task:steer', { taskId: task.id, text: submitted.text.trim() })
      else
        await api('task:send', {
          taskId: task.id,
          requestId: submitted.requestId,
          prompt: submitted.text.trim(),
          attachments: journal.attachments,
        })
      const next = updateLocalDraft((current) =>
        acknowledgeComposerSubmission(current, submitted.requestId),
      )
      draftRef.current = next.text
      onSent()
      await api<Task>('task:update', { taskId: task.id, patch: { draft: next.text } })
      lastSaved.current = next.text
      textarea.current?.focus()
    } catch (error) {
      onError(error)
    } finally {
      sendingRef.current = false
      setSending(false)
    }
  }
  const attach = async () => {
    if (attachingRef.current) return
    attachingRef.current = true
    setMention(null)
    setAttaching(true)
    try {
      const added = await api<Attachment[]>('attachments:add', { taskId: task.id })
      updateLocalDraft((current) => ({
        ...current,
        attachments: [
          ...current.attachments,
          ...added.filter(
            (file) => !current.attachments.some((existing) => existing.path === file.path),
          ),
        ],
      }))
    } catch (error) {
      onError(error)
    } finally {
      attachingRef.current = false
      setAttaching(false)
    }
  }
  const stop = async () => {
    setStopping(true)
    try {
      await api('task:stop', { taskId: task.id })
    } catch (error) {
      setStopping(false)
      onError(error)
    }
  }
  return (
    <div className="composer-region composer-reference">
      <Queue taskId={task.id} onError={onError} />
      {localDraft.pending?.kind === 'steer' && !sending ? (
        <div className="composer-recovery" role="alert">
          <strong>Guidance status needs review</strong>
          <p>
            This guidance may already have reached the running task. Check the conversation before
            sending it again.
          </p>
          <div>
            <button
              className="small-button"
              onClick={() => updateLocalDraft((current) => ({ ...current, pending: null }))}
            >
              Keep as draft
            </button>
            <button
              className="text-button"
              onClick={() => {
                const pending = localDraft.pending
                if (!pending) return
                const next = updateLocalDraft((current) =>
                  acknowledgeComposerSubmission(current, pending.requestId),
                )
                draftRef.current = next.text
              }}
            >
              Mark as sent
            </button>
          </div>
        </div>
      ) : null}
      {projectName || onChooseProject ? (
        <div className="composer-project-strip">
          {onChooseProject ? <button type="button" onClick={onChooseProject} title={projectName || 'Choose project'} aria-label={projectName ? `Choose project, current project ${projectName}` : 'Choose project'}><Folder size={16} /><span>{projectName || 'Choose project'}</span></button> : <span className="composer-project-label"><Folder size={16} /><span>{projectName}</span></span>}
        </div>
      ) : null}
      <div className={`composer ${sending ? 'submitting' : ''}`}>
        {attachments.length ? (
          <div className="composer-attachments">
            {attachments.map((attachment) => (
              <div key={attachment.id} className="attachment-chip">
                <AttachmentLink attachment={attachment} />
                <IconButton
                  label={`Remove ${attachment.name}`}
                  onClick={() =>
                    updateLocalDraft((current) => ({
                      ...current,
                      attachments: current.attachments.filter((file) => file.id !== attachment.id),
                    }))
                  }
                >
                  <X size={12} />
                </IconButton>
              </div>
            ))}
          </div>
        ) : null}
        {mention ? <FileMentionMenu files={mentionFiles} index={mentionIndex} loading={mentionLoading} error={mentionError} onChoose={file=>void chooseMention(file)} /> : null}
        <textarea
          aria-autocomplete="list"
          aria-haspopup="listbox"
          aria-controls={mention ? 'file-mention-list' : undefined}
          aria-expanded={!!mention}
          aria-activedescendant={mention && mentionFiles.length ? `file-mention-${mentionIndex}` : undefined}
          ref={textarea}
          id="prompt-input"
          aria-label="Message"
          placeholder={
            active
              ? 'Add a follow-up or guide the current task…'
              : 'Do anything'
          }
          value={draft}
          rows={2}
          spellCheck={false}
          onChange={(event) => {
            const next = updateLocalDraft((current) => ({ ...current, text: event.target.value }))
            draftRef.current = next.text
            trackMention(next.text, event.target.selectionStart)
          }}
          onClick={event=>trackMention(draftRef.current, event.currentTarget.selectionStart)}
          onKeyUp={event=>{ if (['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) trackMention(draftRef.current, event.currentTarget.selectionStart) }}
          onKeyDown={(event) => {
            if (mention && !event.nativeEvent.isComposing) {
              const action = mentionKey(event.key, mentionFiles.length, mentionIndex, {shiftKey:event.shiftKey})
              if (action.handled) { event.preventDefault(); setMentionIndex(action.index); if (action.close) setMention(null); if (action.commit) void chooseMention(mentionFiles[action.index]); return }
            }
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void submit()
            }
          }}
        />
        <div className="composer-toolbar">
          <div className="composer-controls">
            <IconButton
              label={attaching ? 'Adding attachments' : 'Add files or images'}
              disabled={attaching || sending || (active && sendMode === 'steer')}
              onClick={() => void attach()}
            >
              {attaching ? <Spinner /> : <Plus size={19} />}
            </IconButton>
            <CompactChoice label="Permission mode" value={task.mode} className={`permission-select permission-${task.mode}`} disabled={active || sending || selectingModel} icon={task.mode === 'full' ? <ShieldAlert size={15} strokeWidth={1.6} /> : <ShieldCheck size={15} strokeWidth={1.6} />} options={[
              { value: 'read', label: 'Read only', description: 'Inspect without making changes' },
              { value: 'work', label: 'Workspace access', description: 'Work within this project' },
              { value: 'full', label: 'Full access', description: 'Includes tools for the wider computer' },
            ]} onChoose={mode => onPatch({ mode: mode as PermissionMode })} onError={onError} onOverlay={onModelOverlay} />
          </div>
          <div className="composer-model-controls">
            <ModelPicker task={task} providers={providers} disabled={active || sending} onConnections={onConnections} onOverlay={onModelOverlay} onError={onError} onChoose={async (providerId, modelId) => {
              if (selectingModelRef.current || active || sendingRef.current) return
              const patch = modelSelectionPatch(providers, providerId, modelId, task.effort)
              selectingModelRef.current = true
              setSelectingModel(true)
              try { await onPatch(patch) }
              finally { selectingModelRef.current = false; setSelectingModel(false) }
            }} />
            {model?.efforts?.length ? <CompactChoice label="Reasoning effort" value={task.effort} className="effort-select" disabled={active || sending || selectingModel} options={[
              ...(!model.efforts.includes(task.effort) ? [{ value: task.effort, label: task.effort || 'Default', disabled: true }] : []),
              ...model.efforts.map(effort => ({ value: effort, label: effort.charAt(0).toUpperCase() + effort.slice(1) })),
            ]} onChoose={effort => onPatch({ effort })} onError={onError} onOverlay={onModelOverlay} /> : null}
          </div>
          <div className="composer-send-controls">
            {active ? (
              <IconButton
                label={stopping ? 'Stopping task' : 'Stop task'}
                className="stop-button"
                disabled={stopping}
                onClick={() => void stop()}
              >
                {stopping ? <Spinner /> : <Square size={13} fill="currentColor" />}
              </IconButton>
            ) : null}
            <IconButton
              label={
                sending
                  ? 'Sending'
                  : active
                    ? sendMode === 'steer' && allowSteer
                      ? 'Guide current task'
                      : 'Queue message'
                    : 'Send message'
              }
              className="send-button"
              disabled={
                !draft.trim() || sending || attaching || selectingModel || !available || localDraft.pending?.kind === 'steer'
              }
              onClick={() => void submit()}
            >
              {sending ? <Spinner /> : <ArrowUp size={18} strokeWidth={2} />}
            </IconButton>
          </div>
        </div>
      </div>
      <div className="composer-meta">
        {provider?.available && provider.authenticated !== false && !model ? (
          <span className="connection-warning">Choose a model above</span>
        ) : !available ? (
          <button className="connection-warning" onClick={onConnections}>
            {provider?.authenticated === false
              ? 'Sign in to this connection'
              : provider?.available && !model
                ? 'Choose an available model'
                : 'Set up your connection'}
            <ChevronDown size={11} />
          </button>
        ) : active ? (
          <label className="queue-select">
            <select
              aria-label="Follow-up behavior"
              value={sendMode}
              onChange={(event) => setSendMode(event.target.value as 'queue' | 'steer')}
            >
              <option value="queue">Queue next message</option>
              {allowSteer ? <option value="steer">Guide current task</option> : null}
            </select>
            <ChevronDown size={10} />
          </label>
        ) : (
          <span className="composer-hint">
            Enter to send <span>·</span> Shift Enter for a new line
          </span>
        )}
      </div>
    </div>
  )
}
