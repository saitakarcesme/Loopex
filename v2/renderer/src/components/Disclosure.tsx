import { useEffect, useRef, useState, type PropsWithChildren } from 'react'

/** Keeps content for its exit transition, then releases large tool output DOM. */
export function Disclosure({ open, children }: PropsWithChildren<{ open: boolean }>) {
  const [mounted, setMounted] = useState(open)
  const element = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (open) { setMounted(true); return }
    if (!mounted) return
    const node = element.current
    let alive = true
    const finish = () => { if (alive) setMounted(false) }
    const timer = setTimeout(finish, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 240)
    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target === node && event.propertyName === 'grid-template-rows') finish()
    }
    node?.addEventListener('transitionend', onTransitionEnd)
    return () => { alive = false; clearTimeout(timer); node?.removeEventListener('transitionend', onTransitionEnd) }
  }, [open, mounted])
  return <div ref={element} className={`disclosure-motion ${open ? 'is-open' : ''}`} aria-hidden={!open} inert={!open || undefined}><div>{mounted || open ? children : null}</div></div>
}
