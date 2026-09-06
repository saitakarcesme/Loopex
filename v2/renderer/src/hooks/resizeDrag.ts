interface ResizeTarget extends EventTarget {
  setPointerCapture(pointerId: number): void
  hasPointerCapture(pointerId: number): boolean
  releasePointerCapture(pointerId: number): void
}
interface ResizeDragOptions {
  target: ResizeTarget
  windowTarget: EventTarget
  pointerId: number
  initialWidth: number
  widthAt(clientX: number): number
  onWidth(width: number): void
  onFinish(width: number): void
}

/** A moving separator may lose capture before receiving pointerup. Own the whole drag lifetime. */
export function startResizeDrag(options: ResizeDragOptions): () => void {
  const { target, windowTarget, pointerId } = options
  let finished = false, width = options.initialWidth
  const capture = { capture: true }
  const update = (event: PointerEvent) => {
    if (!Number.isFinite(event.clientX)) return
    const next = options.widthAt(event.clientX)
    if (!Number.isFinite(next) || next === width) return
    width = next
    options.onWidth(width)
  }
  const matches = (event: Event) => (event as PointerEvent).pointerId === pointerId
  const move = (event: Event) => {
    if (finished || !matches(event)) return
    const pointer = event as PointerEvent
    // A missed mouse-up must not let a later hover resize the workspace.
    if (pointer.pointerType === 'mouse' && pointer.buttons === 0) { finish(); return }
    update(pointer)
  }
  const end = (event: Event) => {
    if (finished || !matches(event)) return
    if (event.type === 'pointerup') update(event as PointerEvent)
    finish()
  }
  const finish = () => {
    if (finished) return
    finished = true
    windowTarget.removeEventListener('pointermove', move, capture)
    windowTarget.removeEventListener('pointerup', end, capture)
    windowTarget.removeEventListener('pointercancel', end, capture)
    windowTarget.removeEventListener('blur', finish, capture)
    windowTarget.removeEventListener('pagehide', finish, capture)
    target.removeEventListener('lostpointercapture', end, capture)
    try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* The target may already be detached. */ }
    options.onFinish(width)
  }
  windowTarget.addEventListener('pointermove', move, capture)
  windowTarget.addEventListener('pointerup', end, capture)
  windowTarget.addEventListener('pointercancel', end, capture)
  windowTarget.addEventListener('blur', finish, capture)
  windowTarget.addEventListener('pagehide', finish, capture)
  target.addEventListener('lostpointercapture', end, capture)
  // Window listeners still support the drag if Chromium refuses capture on a detached separator.
  try { target.setPointerCapture(pointerId) } catch { /* Continue with window-scoped events. */ }
  return finish
}
