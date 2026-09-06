import { Check, ChevronDown } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { choiceKey, restoreChoiceFocus, type CompactOption } from './compactChoiceState'
import { Spinner } from './Primitives'

export function CompactChoice({ label, value, options, disabled, icon, className = '', onChoose, onError, onOverlay }: {
  label: string; value: string; options: CompactOption[]; disabled?: boolean; icon?: ReactNode; className?: string
  onChoose(value: string): Promise<unknown>; onError(error: unknown): void; onOverlay(open: boolean): void
}) {
  const [open, setOpen] = useState(false), trigger = useRef<HTMLButtonElement>(null)
  const selected = options.find(option => option.value === value)
  useEffect(() => { if (disabled) setOpen(false) }, [disabled])
  return <>
    <button ref={trigger} type="button" className={`compact-choice-trigger ${className}`} aria-label={`${label}: ${selected?.label || value || 'Default'}`} aria-haspopup="listbox" aria-expanded={open} disabled={disabled} onClick={() => setOpen(current => !current)} onKeyDown={event => {
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true) }
    }}>{icon}<span>{selected?.label || value || 'Default'}</span><ChevronDown size={12} strokeWidth={1.6} /></button>
    {open ? <ChoicePopover label={label} value={value} options={options} trigger={trigger.current} onChoose={onChoose} onError={onError} onOverlay={onOverlay} onClose={() => setOpen(false)} /> : null}
  </>
}
function ChoicePopover({ label, value, options, trigger, onChoose, onError, onOverlay, onClose }: {
  label: string; value: string; options: CompactOption[]; trigger: HTMLButtonElement | null
  onChoose(value: string): Promise<unknown>; onError(error: unknown): void; onOverlay(open: boolean): void; onClose(): void
}) {
  const root = useRef<HTMLDivElement>(null), mounted = useRef(true), busyRef = useRef(false)
  const callbacks = useRef({ onClose, onOverlay }); callbacks.current = { onClose, onOverlay }
  const [busy, setBusy] = useState(false), [active, setActive] = useState(options.find(option => option.value === value && !option.disabled)?.value ?? options.find(option => !option.disabled)?.value ?? '')
  const [position, setPosition] = useState({ left: 12, bottom: 70, maxHeight: 360 })
  const close = (reason: 'escape' | 'selection' | 'tab' | 'outside') => { restoreChoiceFocus(trigger, reason); callbacks.current.onClose() }
  useLayoutEffect(() => {
    mounted.current = true; callbacks.current.onOverlay(true)
    const place = () => { const bounds = trigger?.getBoundingClientRect(); setPosition({ left: Math.max(12, Math.min(bounds?.left || 12, window.innerWidth - 264)), bottom: Math.max(12, window.innerHeight - (bounds?.top || window.innerHeight - 70) + 8), maxHeight: Math.min(360, Math.max(120, (bounds?.top || 400) - 20)) }) }
    place(); window.addEventListener('resize', place)
    return () => { mounted.current = false; callbacks.current.onOverlay(false); window.removeEventListener('resize', place) }
  }, [trigger])
  useLayoutEffect(() => { root.current?.querySelector<HTMLButtonElement>('[tabindex="0"]')?.focus({ preventScroll: true }) }, [active])
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target) && !trigger?.contains(event.target)) close('outside') }
    document.addEventListener('pointerdown', outside, true); return () => document.removeEventListener('pointerdown', outside, true)
  }, [trigger])
  const choose = async (next: string) => {
    if (busyRef.current || !options.some(option => option.value === next && !option.disabled)) return
    busyRef.current = true; setBusy(true)
    try { await onChoose(next); if (mounted.current) close('selection') }
    catch (error) { onError(error) }
    finally { busyRef.current = false; if (mounted.current) setBusy(false) }
  }
  return createPortal(<div ref={root} className="compact-choice-popover" style={position} role="listbox" aria-label={label} aria-busy={busy} onKeyDown={event => {
    if (event.key === 'Tab') { close('tab'); return }
    const action = choiceKey(event.key, options, active, event.nativeEvent.isComposing)
    if (!action.handled) return
    event.preventDefault(); event.stopPropagation()
    if (action.close) close('escape')
    else if (!busy && action.value !== undefined) setActive(action.value)
    else if (!busy && action.commit !== undefined) void choose(action.commit)
  }}>
    {options.map(option => <button key={option.value} type="button" role="option" aria-selected={option.value === value} aria-disabled={option.disabled || busy} tabIndex={option.value === active ? 0 : -1} className="compact-choice-option" onFocus={() => setActive(option.value)} onClick={() => void choose(option.value)}>
      <span><span>{option.label}</span>{option.description ? <small>{option.description}</small> : null}</span>{option.value === value ? <Check size={15} strokeWidth={1.7} /> : null}
    </button>)}
    {busy ? <div className="compact-choice-saving" role="status"><Spinner size={12} />Applying…</div> : null}
  </div>, document.body)
}
