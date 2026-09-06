import { Check, ChevronDown, Search, Settings2, X } from 'lucide-react'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ProviderInfo, Task } from '../../../shared/contracts'
import { errorText } from '../api'
import { IconButton, Spinner } from './Primitives'
import { modelChoices, providerAvailability, type ModelChoice } from './modelPickerState'

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
      <span>{label}</span><span className="model-picker-provider">{provider?.name || task.providerId}</span><ChevronDown size={11} />
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
  const [limit, setLimit] = useState(60)
  const [highlight, setHighlight] = useState<string | null>(`${task.providerId}:${task.model}`)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [position, setPosition] = useState({ left: 12, bottom: 70, width: 380, maxHeight: 440 })
  const root = useRef<HTMLDivElement>(null), search = useRef<HTMLInputElement>(null), busyRef = useRef(false), mounted = useRef(true)
  const closeRef = useRef(onClose), overlayRef = useRef(onOverlay)
  closeRef.current = onClose
  const choices = modelChoices(providers, query)
  const visible = choices.slice(0, limit)
  const enabled = visible.filter(choice => choice.enabled)
  const active = enabled.find(choice => choice.key === highlight) || enabled[0]
  const optionId = (key: string) => `${id}-option-${encodeURIComponent(key)}`
  useLayoutEffect(() => {
    mounted.current = true
    overlayRef.current(true)
    const position = () => {
      const bounds = trigger?.getBoundingClientRect()
      const width = Math.min(400, window.innerWidth - 24)
      setPosition({ left: Math.max(12, Math.min(bounds?.left || 12, window.innerWidth - width - 12)), bottom: Math.max(12, window.innerHeight - (bounds?.top || window.innerHeight - 70) + 8), width, maxHeight: Math.min(440, Math.max(160, (bounds?.top || 480) - 24)) })
    }
    position()
    search.current?.focus()
    window.addEventListener('resize', position)
    return () => {
      mounted.current = false
      overlayRef.current(false)
      window.removeEventListener('resize', position)
      if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true })
    }
  }, [trigger])
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger?.contains(event.target)) closeRef.current()
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
    try { await onChoose(choice.provider.id, choice.model.id); closeRef.current() }
    catch (error) { if (mounted.current) setError(errorText(error)); else onError(error) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return createPortal(<div ref={root} className="model-picker-popover" style={position} role="dialog" aria-modal="true" aria-label="Choose model and connection" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
    if (event.key === 'Tab') {
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') || [])]
      const first = focusable[0], last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }
  }}>
    <div className="model-picker-search"><Search size={15} /><input ref={search} value={query} role="combobox" aria-label="Search models and connections" aria-autocomplete="list" aria-expanded="true" aria-controls={`${id}-list`} aria-activedescendant={active ? optionId(active.key) : undefined} placeholder="Search models or connections…" onChange={event => { setQuery(event.target.value); setLimit(60); setHighlight(null) }} onKeyDown={event => {
      if (event.nativeEvent.isComposing) return
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (!enabled.length) return
        const current = Math.max(0, enabled.findIndex(choice => choice.key === active?.key))
        setHighlight(enabled[(current + (event.key === 'ArrowDown' ? 1 : enabled.length - 1)) % enabled.length].key)
      } else if (event.key === 'Enter' && active) { event.preventDefault(); void choose(active) }
    }} /><IconButton label="Close model picker" onClick={onClose}><X size={14} /></IconButton></div>
    {error ? <p className="model-picker-error" role="alert">{error}</p> : null}
    {busy ? <p className="model-picker-operation" role="status"><Spinner size={12} />Changing model…</p> : null}
    <div className="model-picker-list" id={`${id}-list`} role="listbox" aria-label="Available models">
      {providers.map(provider => {
        const group = visible.filter(choice => choice.provider.id === provider.id)
        if (query && !group.length && !`${provider.name} ${provider.connectionLabel}`.toLowerCase().includes(query.trim().toLowerCase())) return null
        return <div key={provider.id} role="group" aria-label={provider.name} className="model-picker-group">
          <div className="model-picker-group-title"><strong>{provider.name}</strong><span>{providerAvailability(provider)}</span></div>
          {!provider.available || provider.authenticated === false ? <p className="model-picker-unavailable">{provider.error || 'Open Connections to make this connection available.'}</p> : !provider.models.length ? <p className="model-picker-unavailable">Refresh or configure this connection to load its models.</p> : null}
          {group.map(choice => <div key={choice.key} id={optionId(choice.key)} role="option" aria-selected={choice.provider.id === task.providerId && choice.model.id === task.model} aria-disabled={!choice.enabled || busy} className={`model-picker-option ${active?.key === choice.key ? 'highlighted' : ''}`} onPointerMove={() => { if (choice.enabled) setHighlight(choice.key) }} onClick={() => void choose(choice)}>
            <div><span>{choice.model.name}</span><small>{choice.model.description || choice.model.id}</small></div>
            {choice.provider.id === task.providerId && choice.model.id === task.model ? <Check size={14} /> : null}
          </div>)}
        </div>
      })}
      {!choices.length && query ? <p className="model-picker-unavailable">No models match “{query}”.</p> : null}
    </div>
    {choices.length > limit ? <button className="model-picker-more" onClick={() => setLimit(value => value + 60)}>Show more models ({choices.length - limit})</button> : null}
    {!providers.some(provider => provider.id === task.providerId && provider.models.some(model => model.id === task.model)) && task.model ? <p className="model-picker-unavailable">Current model “{task.model}” is not in the catalog. Choose a listed model to continue.</p> : null}
    <button className="model-picker-connections" onClick={() => { onClose(); onConnections() }}><Settings2 size={14} />Manage connections</button>
  </div>, document.body)
}
