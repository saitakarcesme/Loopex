import { Check, ChevronDown, Search, Settings2, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderInfo, Task } from '../../../shared/contracts'
import { errorText } from '../api'
import { IconButton, Spinner } from './Primitives'
import { restoreChoiceFocus } from './compactChoiceState'
import { modelChoices, modelTriggerLabel, type ModelChoice } from './modelPickerState'

export function ModelPicker({ task, providers, disabled, onChoose, onConnections, onOverlay, onError }: {
  task: Task; providers: ProviderInfo[]; disabled: boolean
  onChoose: (providerId: string, modelId: string) => Promise<void>
  onConnections: () => void; onOverlay: (open: boolean) => void; onError: (error: unknown) => void
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const provider = providers.find(item => item.id === task.providerId)
  const model = provider?.models.find(item => item.id === task.model)
  const label = model?.name || task.model || 'Choose model'
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <>
    <button ref={trigger} type="button" className="model-picker-trigger" aria-label={`Choose model and connection: ${label}, ${provider?.name || task.providerId}`} aria-haspopup="dialog" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)} title={`${label} · ${provider?.name || task.providerId}`}>
      <span className={`provider-dot ${provider?.available && provider.authenticated !== false ? '' : 'unavailable'}`} />
      <span>{modelTriggerLabel(task.providerId, label)}</span><span className="model-picker-provider">{provider?.name || task.providerId}</span><ChevronDown size={11} />
    </button>
    {open ? <ModelPickerPopover task={task} providers={providers} trigger={trigger.current} onClose={() => setOpen(false)} onChoose={onChoose} onConnections={onConnections} onOverlay={onOverlay} onError={onError} /> : null}
  </>
}

function ModelPickerPopover({ task, providers, trigger, onClose, onChoose, onConnections, onOverlay, onError }: {
  task: Task; providers: ProviderInfo[]; trigger: HTMLButtonElement | null
  onClose: () => void; onChoose: (providerId: string, modelId: string) => Promise<void>
  onConnections: () => void; onOverlay: (open: boolean) => void; onError: (error: unknown) => void
}) {
  const id = useId()
  const [query, setQuery] = useState('')
  const [limit, setLimit] = useState(40)
  const [connectionId, setConnectionId] = useState(task.providerId)
  const [highlight, setHighlight] = useState<string | null>(`${task.providerId}:${task.model}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 12, bottom: 70, width: 340, maxHeight: 420 })
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), busyRef = useRef(false), mounted = useRef(true)
  const closeRef = useRef(onClose), overlayRef = useRef(onOverlay)
  closeRef.current = onClose
  const close = (reason: 'escape' | 'selection' | 'outside') => { restoreChoiceFocus(trigger, reason); closeRef.current() }
  const connection = providers.find(provider => provider.id === connectionId)
  const choices = modelChoices(connection ? [connection] : [], query)
  const visible = choices.slice(0, limit)
  const enabled = visible.filter(choice => choice.enabled)
  const active = enabled.find(choice => choice.key === highlight) || enabled[0]
  const optionId = (key: string) => `${id}-option-${encodeURIComponent(key)}`
  useLayoutEffect(() => {
    mounted.current = true
    overlayRef.current(true)
    const position = () => {
      const bounds = trigger?.getBoundingClientRect()
      const width = Math.min(350, window.innerWidth - 24)
      setPosition({ left: Math.max(12, Math.min(bounds?.left || 12, window.innerWidth - width - 12)), bottom: Math.max(12, window.innerHeight - (bounds?.top || window.innerHeight - 70) + 8), width, maxHeight: Math.min(420, Math.max(160, (bounds?.top || 480) - 24)) })
    }
    position()
    search.current?.focus()
    window.addEventListener('resize', position)
    return () => {
      mounted.current = false
      overlayRef.current(false)
      window.removeEventListener('resize', position)
    }
  }, [trigger])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger?.contains(event.target)) close('outside')
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [trigger])
  useEffect(() => {
    if (active) document.getElementById(optionId(active.key))?.scrollIntoView({ block: 'nearest' })
  }, [active?.key])
  const choose = async (choice: ModelChoice) => {
    if (!choice.enabled || busyRef.current) return
    busyRef.current = true
    setBusy(true); setError(null)
    try { await onChoose(choice.provider.id, choice.model.id); if (mounted.current) close('selection') }
    catch (error) { if (mounted.current) setError(errorText(error)); else onError(error) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return createPortal(<div ref={root} className="model-picker-popover" style={position} role="dialog" aria-modal="true" aria-label="Choose model and connection" onKeyDown={event => {
    if (event.nativeEvent.isComposing) return
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close('escape') }
    if (event.key === 'Tab') {
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || [])]
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <div className="model-picker-search"><Search size={15} /><input ref={search} value={query} role="combobox" aria-label="Search models and connections" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={active ? optionId(active.key) : undefined} placeholder="Search models" onChange={event => { setQuery(event.target.value); setLimit(40); setHighlight(null) }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!enabled.length) return
        const current = Math.max(0, enabled.findIndex(choice => choice.key === active?.key))
        setHighlight(enabled[(current + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length].key)
      } else if (event.key === 'Enter' && active) { event.preventDefault(); void choose(active) }
    }} /><IconButton label="Close model picker" onClick={() => close('escape')}><X size={14} /></IconButton></div>
    {error ? <p className="model-picker-error" role="alert">{error}</p> : null}
    {busy ? <p className="model-picker-operation" role="status"><Spinner size={12} />Changing model…</p> : null}
    <div className="model-picker-connection-tabs" role="group" aria-label="Model connections">
      {providers.map(provider => <button key={provider.id} type="button" aria-pressed={connectionId === provider.id} disabled={busy} title={provider.connectionLabel} onClick={() => { setConnectionId(provider.id); setQuery(''); setLimit(40); setHighlight(null); search.current?.focus() }}><span className={`connection-state-dot ${provider.available && provider.authenticated !== false ? 'ready' : ''}`} />{provider.name}</button>)}
    </div>
    <div className="model-picker-list" id={`${id}-list`} role="listbox" aria-label={`Models from ${connection?.name || 'selected connection'}`}>
      {choices.length ? visible.map(choice => <div key={choice.key} id={optionId(choice.key)} role="option" aria-selected={choice.provider.id === task.providerId && choice.model.id === task.model} aria-disabled={!choice.enabled || busy} title={choice.model.description || choice.model.id} className={`model-picker-option ${active?.key === choice.key ? 'highlighted' : ''}`} onPointerMove={() => { if (choice.enabled) setHighlight(choice.key) }} onClick={() => void choose(choice)}>
        <span>{choice.model.name}</span>{choice.provider.id === task.providerId && choice.model.id === task.model ? <Check size={15} strokeWidth={1.7} /> : null}
      </div>) : <p className="model-picker-unavailable">{query ? `No models match “${query}”.` : !connection?.available ? 'Connection unavailable.' : connection.authenticated === false ? 'Sign in to use this connection.' : 'No models available.'}</p>}
    </div>
    {connection && (!connection.available || connection.authenticated === false) && choices.length ? <p className="model-picker-unavailable">{connection.authenticated === false ? 'Sign in to use this connection.' : 'Connection unavailable.'}</p> : null}
    {choices.length > limit ? <button className="model-picker-more" onClick={() => setLimit(value => value + 40)}>Show more</button> : null}
    {!providers.some(provider => provider.id === task.providerId && provider.models.some(model => model.id === task.model)) && task.model ? <p className="model-picker-unavailable">Current model “{task.model}” is not in the catalog. Choose a listed model to continue.</p> : null}
    <button className="model-picker-connections" onClick={() => { close('outside'); onConnections() }}><Settings2 size={14} />Manage connections</button>
  </div>, document.body)
}
