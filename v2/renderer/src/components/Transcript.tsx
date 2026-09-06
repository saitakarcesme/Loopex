import {
  ArrowDown,
  ArrowUpRight,
  Check,
  ChevronRight,
  CircleAlert,
  Copy,
  FileCode2,
  MessageSquare,
  RotateCcw,
  ScrollText,
  Terminal,
  Wrench,
} from 'lucide-react'
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Activity, Message, PendingRequest, Task } from '../../../shared/contracts'
import { compactNumber, isActive, statusLabel } from '../api'
import { CheckpointReview } from './CheckpointReview'
import { AttachmentLink } from './ArtifactPreview'
import { Markdown } from './Markdown'
import { IconButton, Spinner } from './Primitives'

const scrollPositions = new Map<string, { top: number; pinned: boolean }>()
export function ActivityRow({
  activity,
  onOpenFile,
  onError,
}: {
  activity: Activity
  onOpenFile: (path: string) => void
  onError: (error: unknown) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const unverified = activity.status === 'interrupted' || activity.status === 'unknown'
  if (activity.kind === 'commentary')
    return (
      <div className="commentary">
        <Markdown
          text={activity.detail || activity.title}
          onOpenFile={onOpenFile}
          onError={onError}
        />
        {unverified ? <span className="activity-unverified">Outcome not recorded</span> : null}
      </div>
    )
  const Icon =
    unverified || activity.status === 'failed'
      ? CircleAlert
      : activity.kind === 'command'
      ? Terminal
      : activity.kind === 'file'
        ? FileCode2
        : activity.kind === 'error'
          ? CircleAlert
          : activity.kind === 'plan'
            ? Check
            : Wrench
  return (
    <div className={`activity ${activity.status}`}>
      <button
        className="activity-summary"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        {activity.status === 'running' ? <Spinner size={13} /> : <Icon size={14} />}
        <span>{activity.title}</span>
        {activity.status === 'failed' ? <span className="activity-failed">Failed</span> : null}
        {unverified ? (
          <span className="activity-unverified" title={activity.importProvenance?.originalStatus
            ? `Previous Akorith status: ${activity.importProvenance.originalStatus}`
            : 'This activity has no recorded outcome.'}>
            {activity.importProvenance || activity.status === 'unknown' ? 'Outcome not recorded' : 'Interrupted'}
          </span>
        ) : null}
        {activity.detail ? <ChevronRight className={expanded ? 'rotated' : ''} size={13} /> : null}
      </button>
      {expanded && activity.detail ? (
        <div className="activity-detail">
          {activity.kind === 'plan' ? (
            <Markdown text={activity.detail} onOpenFile={onOpenFile} onError={onError} />
          ) : (
            <pre>{activity.detail}</pre>
          )}
          {activity.filePath ? (
            <button className="text-button" onClick={() => onOpenFile(activity.filePath!)}>
              Open file <ArrowUpRight size={12} />
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
export const MessageView = memo(function MessageView({
  message,
  undoBlockReason,
  onOpenFile,
  onError,
  onOverlay,
  onContext,
}: {
  message: Message
  undoBlockReason: string | null
  onOpenFile: (path: string) => void
  onError: (error: unknown) => void
  onOverlay: (open: boolean) => void
  onContext: (taskId: string, turnId: string) => void
}) {
  const [copied, setCopied] = useState(false)
  const activityCount = message.activities.filter(
    (activity) => activity.kind !== 'commentary',
  ).length
  const [showAll, setShowAll] = useState(false)
  const active = isActive(message.status)
  const providerNames = { codex: 'Codex', claude: 'Claude', opencode: 'OpenCode', ollama: 'Ollama' }
  const attribution = message.attribution
  const providerName = attribution?.providerId
    ? providerNames[attribution.providerId]
    : attribution?.originalProviderId
      ? `Unknown provider (${attribution.originalProviderId})`
      : undefined
  const historicalOutcome = message.importProvenance
    ? !message.importProvenance.outcomeRecorded
      ? 'Imported history. The outcome was not recorded.'
      : message.importProvenance.lifecycle === 'timed_out'
        ? 'This imported turn timed out. Partial work is preserved.'
        : undefined
    : undefined
  const lastActivityIds = new Set(
    message.activities
      .filter((activity) => activity.kind !== 'commentary')
      .slice(-3)
      .map((activity) => activity.id),
  )
  const visibleActivities =
    showAll || active || activityCount <= 6
      ? message.activities
      : message.activities.filter(
          (activity) => activity.kind === 'commentary' || lastActivityIds.has(activity.id),
        )
  return (
    <article
      data-message-id={message.id}
      data-task-id={message.taskId}
      data-turn-id={message.turnId}
      className={`message message-${message.role}`}
      aria-label={message.role === 'user' ? 'Your message' : 'Assistant response'}
    >
      {message.role === 'user' ? (
        <>
          <div className="user-message-body">{message.content}</div>
          {message.attachments?.length ? (
            <div className="message-attachments">
              {message.attachments.map((attachment) => (
                <AttachmentLink key={attachment.id} attachment={attachment} />
              ))}
            </div>
          ) : null}
          {message.status === 'queued' ? <span className="queued-label">Queued</span> : null}
        </>
      ) : (
        <>
          <div className="assistant-activities">
            {activityCount > 6 && !active ? (
              <button className="activity-expand" onClick={() => setShowAll((value) => !value)}>
                <ChevronRight size={13} className={showAll ? 'rotated' : ''} />
                {showAll ? 'Collapse activity' : `Show all ${activityCount} actions`}
              </button>
            ) : null}
            {visibleActivities.map((activity) => (
              <ActivityRow
                key={activity.id}
                activity={activity}
                onOpenFile={onOpenFile}
                onError={onError}
              />
            ))}
          </div>
          {message.content ? (
            <Markdown text={message.content} onOpenFile={onOpenFile} onError={onError} />
          ) : null}
          {active ? (
            <div className="live-state" role="status">
              <span className="live-orb" />
              <span>{statusLabel[message.status]}</span>
            </div>
          ) : null}
          {!active && (historicalOutcome || ['failed', 'cancelled', 'interrupted'].includes(message.status)) ? (
            <div className={`turn-outcome ${message.status}`}>
              <CircleAlert size={13} />
              {historicalOutcome || (message.status === 'cancelled'
                ? 'Stopped. Partial work is preserved.'
                : message.status === 'interrupted'
                  ? 'Interrupted. Send a message to continue.'
                  : 'This turn could not finish. Details are shown above.')}
            </div>
          ) : null}
          {message.importProvenance?.workspaceGoal ? (
            <div className="imported-goal" aria-label="Imported goal status">
              Previous goal: {message.importProvenance.workspaceGoal.status}. Historical record.
            </div>
          ) : null}
          {(
            <div className="message-footer">
              {!active && message.content ? <IconButton
                label={copied ? 'Copied' : 'Copy response'}
                onClick={() =>
                  void navigator.clipboard
                    .writeText(message.content)
                    .then(() => {
                      setCopied(true)
                      setTimeout(() => setCopied(false), 1400)
                    })
                    .catch(onError)
                }
              >
                {copied ? <Check size={13} /> : <Copy size={13} />}
              </IconButton> : null}
              <button className="text-button message-context-button" aria-label="Inspect turn context" onClick={() => onContext(message.taskId, message.turnId)}>
                <ScrollText size={12} />Context
              </button>
              {providerName || attribution?.model ? (
                <span className="message-attribution" title={[providerName, attribution?.model].filter(Boolean).join(' · ')}>
                  {[providerName, attribution?.model].filter(Boolean).join(' · ')}
                </span>
              ) : null}
              {message.usage?.totalTokens ? (
                <span title={`${message.usage.totalTokens.toLocaleString()} total tokens`}>
                  {compactNumber(message.usage.totalTokens)} tokens
                  {message.usage.estimated ? ' · estimated' : ''}
                </span>
              ) : null}
              {message.usage?.costUsd !== undefined ? (
                <span>${message.usage.costUsd.toFixed(4)}</span>
              ) : null}
              {!active && !message.importProvenance ? <CheckpointReview
                taskId={message.taskId}
                turnId={message.turnId}
                undoBlockReason={undoBlockReason}
                onOpenFile={onOpenFile}
                onOverlay={onOverlay}
              /> : null}
            </div>
          )}
        </>
      )}
    </article>
  )
})

export function PendingCard({
  request,
  onRespond,
  onError,
}: {
  request: PendingRequest
  onRespond: (requestId: string, response: unknown) => Promise<void>
  onError: (error: unknown) => void
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [freeform, setFreeform] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async (response: unknown) => {
    setBusy(true)
    try {
      await onRespond(request.id, response)
    } catch (error) {
      onError(error)
      setBusy(false)
    }
  }
  return (
    <section
      className="pending-card"
      aria-label={request.kind === 'approval' ? 'Approval requested' : 'Question'}
    >
      <div className="pending-title">
        <MessageSquare size={16} />
        <h3>{request.title}</h3>
      </div>
      {request.detail ? <pre className="pending-detail">{request.detail}</pre> : null}
      {request.kind === 'approval' && (!request.detail?.trim() || request.detail.trim() === '*') ? <p className="settings-description">
        {request.detail?.trim() === '*' ? 'The provider supplied only “*” as the request detail. No specific target was provided.' : 'The provider did not supply command or target details for this request.'}
      </p> : null}
      {request.kind === 'approval' ? (
        <div className="pending-actions">
          {(request.choices?.length ? request.choices : ['approve', 'reject']).map(
            (choice, index) => (
              <button
                key={choice}
                disabled={busy}
                className={index === 0 ? 'primary-button' : 'secondary-button'}
                onClick={() => void submit(choice)}
              >
                {choice
                  .replace(/([a-z])([A-Z])/g, '$1 $2')
                  .replace(/^./, (value) => value.toUpperCase())}
              </button>
            ),
          )}
        </div>
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault()
            void submit(request.questions?.length ? { answers } : freeform)
          }}
        >
          {request.questions?.length ? (
            request.questions.map((question) => (
              <fieldset key={question.id} className="question-field">
                <legend>{question.question}</legend>
                {question.options?.map((option) => (
                  <label
                    key={option.label}
                    className={`question-option ${answers[question.id] === option.label ? 'chosen' : ''}`}
                  >
                    <input
                      type="radio"
                      name={question.id}
                      value={option.label}
                      checked={answers[question.id] === option.label}
                      onChange={() =>
                        setAnswers((current) => ({ ...current, [question.id]: option.label }))
                      }
                    />
                    <span>
                      {option.label}
                      {option.description ? <small>{option.description}</small> : null}
                    </span>
                  </label>
                ))}
                <input
                  aria-label={`Your answer: ${question.question}`}
                  placeholder={
                    question.options?.length ? 'Or write your own answer…' : 'Your answer…'
                  }
                  value={
                    question.options?.some((option) => option.label === answers[question.id])
                      ? ''
                      : answers[question.id] || ''
                  }
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question.id]: event.target.value }))
                  }
                />
              </fieldset>
            ))
          ) : (
            <textarea
              aria-label="Your answer"
              value={freeform}
              onChange={(event) => setFreeform(event.target.value)}
              placeholder="Your answer…"
            />
          )}
          <div className="pending-actions">
            <button
              className="primary-button"
              disabled={
                busy ||
                (request.questions?.length
                  ? request.questions.some((question) => !answers[question.id]?.trim())
                  : !freeform.trim())
              }
            >
              {busy ? <Spinner /> : null}Send answer
            </button>
          </div>
        </form>
      )}
    </section>
  )
}

export function Transcript({
  task,
  messages,
  pending,
  onRespond,
  onOpenFile,
  onError,
  onOverlay,
  onContext,
}: {
  task: Task
  messages: Message[]
  pending: PendingRequest[]
  onRespond: (requestId: string, response: unknown) => Promise<void>
  onOpenFile: (path: string) => void
  onError: (error: unknown) => void
  onOverlay: (open: boolean) => void
  onContext: (taskId: string, turnId: string) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [limit, setLimit] = useState(100)
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const saved = scrollPositions.get(task.id)
    pinned.current = saved?.pinned ?? true
    element.scrollTop = pinned.current ? element.scrollHeight : saved?.top || 0
    setShowJump(!pinned.current)
    return () => {
      scrollPositions.set(task.id, { top: element.scrollTop, pinned: pinned.current })
    }
  }, [task.id])
  useEffect(() => {
    if (!content.current) return
    const observer = new ResizeObserver(() => {
      if (pinned.current && scroller.current)
        scroller.current.scrollTop = scroller.current.scrollHeight
    })
    observer.observe(content.current)
    return () => observer.disconnect()
  }, [])
  const jump = () => {
    pinned.current = true
    setShowJump(false)
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
  }
  return (
    <div className="transcript-region">
      <div
        ref={scroller}
        className="transcript-scroll"
        onScroll={(event) => {
          const element = event.currentTarget
          pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64
          setShowJump(!pinned.current)
        }}
      >
        <div ref={content} className="transcript-content">
          {messages.length > limit ? (
            <button
              className="load-earlier"
              onClick={() => {
                const element = scroller.current
                const previousHeight = element?.scrollHeight || 0
                setLimit((value) => value + 100)
                requestAnimationFrame(() => {
                  if (element) element.scrollTop += element.scrollHeight - previousHeight
                })
              }}
            >
              <RotateCcw size={13} />
              Load earlier messages ({messages.length - limit})
            </button>
          ) : null}
          {messages.slice(-limit).map((message) => (
            <MessageView
              key={message.id}
              message={message}
              undoBlockReason={isActive(task.status) ? 'Stop the active task before restoring a file.' : task.mode === 'read' ? 'Switch this task to Workspace access to restore a file.' : null}
              onOpenFile={onOpenFile}
              onError={onError}
              onOverlay={onOverlay}
              onContext={onContext}
            />
          ))}
          {pending.map((request) => (
            <PendingCard
              key={request.id}
              request={request}
              onRespond={onRespond}
              onError={onError}
            />
          ))}
        </div>
      </div>
      {showJump ? (
        <button className="jump-to-latest" onClick={jump}>
          <ArrowDown size={14} />
          Latest
        </button>
      ) : null}
    </div>
  )
}
