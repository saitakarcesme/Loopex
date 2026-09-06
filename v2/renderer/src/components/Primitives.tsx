import { X } from 'lucide-react'
import {
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { createPortal } from 'react-dom'

export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      type="button"
      {...props}
      className={`icon-button ${props.className || ''}`}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  )
}
export function Dialog({
  title,
  onClose,
  children,
  className = '',
  labelled = true,
}: PropsWithChildren<{
  title: string
  onClose: () => void
  className?: string
  labelled?: boolean
}>) {
  const ref = useRef<HTMLDivElement>(null)
  const [closing, setClosing] = useState(false)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const requestClose = () => {
    if (closeTimer.current) return
    setClosing(true)
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null
      onClose()
      setClosing(false)
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 110)
  }
  const closeRef = useRef(onClose)
  closeRef.current = requestClose
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const panel = ref.current
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]',
        ) || [],
      ).filter((element) => element.getClientRects().length)
    ;(
      panel?.querySelector<HTMLElement>('[autofocus], [data-autofocus]') ||
      focusable()[0] ||
      panel
    )?.focus()
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        closeRef.current()
      }
      if (event.key === 'Tab') {
        const items = focusable()
        if (!items.length) {
          event.preventDefault()
          return
        }
        if (!panel?.contains(document.activeElement)) {
          event.preventDefault()
          ;(event.shiftKey ? items.at(-1) : items[0])?.focus()
          return
        }
        const first = items[0],
          last = items.at(-1)!
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first.focus()
        }
      }
    }
    document.addEventListener('keydown', keydown)
    return () => {
      if (closeTimer.current) clearTimeout(closeTimer.current)
      document.removeEventListener('keydown', keydown)
      previous?.focus()
    }
  }, [])
  return createPortal(
    <div
      className={`modal-backdrop ${closing ? 'is-closing' : ''}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`dialog ${className}`}
      >
        {labelled ? (
          <div className="dialog-heading">
            <h2>{title}</h2>
            <IconButton label="Close" onClick={requestClose}>
              <X size={18} />
            </IconButton>
          </div>
        ) : null}
        {children}
      </div>
    </div>,
    document.body,
  )
}
export function EmptyState({
  icon,
  title,
  children,
  action,
}: PropsWithChildren<{ icon: ReactNode; title: string; action?: ReactNode }>) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <h3>{title}</h3>
      <div className="empty-state-description">{children}</div>
      {action}
    </div>
  )
}
export function Toggle({
  checked,
  label,
  onChange,
  disabled,
}: {
  checked: boolean
  label: string
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle ${checked ? 'on' : ''}`}
      onClick={() => onChange(!checked)}
      disabled={disabled}
    >
      <span />
    </button>
  )
}
export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="Loading" />
}
