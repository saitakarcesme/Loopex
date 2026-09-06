import test from 'node:test'
import assert from 'node:assert/strict'
import { startResizeDrag } from '../src/hooks/resizeDrag'

function pointer(type: string, clientX: number, pointerId = 7, buttons = type === 'pointerup' ? 0 : 1) {
  return Object.assign(new Event(type), { pointerId, clientX, buttons, pointerType: 'mouse' })
}
class Separator extends EventTarget {
  captured = false
  rejectCapture = false
  setPointerCapture() { if (this.rejectCapture) throw new Error('detached'); this.captured = true }
  hasPointerCapture() { return this.captured }
  releasePointerCapture() { this.captured = false; this.dispatchEvent(pointer('lostpointercapture', 0)) }
}
function fixture(rejectCapture = false, reverse = false) {
  const windowTarget = new EventTarget(), target = new Separator(), rendered: number[] = [], saved: number[] = []
  target.rejectCapture = rejectCapture
  const finish = startResizeDrag({ target, windowTarget, pointerId: 7, initialWidth: 253,
    widthAt: x => Math.round(Math.max(200, Math.min(340, 253 + (x - 223) * (reverse ? -1 : 1)))),
    onWidth: width => rendered.push(width), onFinish: width => saved.push(width),
  })
  return { windowTarget, target, rendered, saved, finish }
}
test('window release persists final coordinate even when separator never receives pointerup', () => {
  const f = fixture()
  f.windowTarget.dispatchEvent(pointer('pointermove', 230))
  f.windowTarget.dispatchEvent(pointer('pointerup', 234))
  assert.deepEqual(f.rendered, [260, 264]); assert.deepEqual(f.saved, [264]); assert.equal(f.target.captured, false)
  f.windowTarget.dispatchEvent(pointer('pointermove', 300)); f.windowTarget.dispatchEvent(pointer('pointerup', 310)); f.finish()
  assert.deepEqual(f.saved, [264]); assert.deepEqual(f.rendered, [260, 264])
})
test('lost capture and cancel save last rendered width, ignoring meaningless cancellation coordinates', () => {
  for (const kind of ['lostpointercapture', 'pointercancel']) {
    const f = fixture(); f.windowTarget.dispatchEvent(pointer('pointermove', 244))
    ;(kind === 'lostpointercapture' ? f.target : f.windowTarget).dispatchEvent(pointer(kind, 0))
    f.windowTarget.dispatchEvent(pointer('pointerup', 290)); f.finish()
    assert.deepEqual(f.saved, [274])
  }
})
test('other pointer events cannot move or finish a resize; capture failure retains window fallback', () => {
  const f = fixture(true)
  f.windowTarget.dispatchEvent(pointer('pointermove', 330, 8)); f.windowTarget.dispatchEvent(pointer('pointerup', 330, 8))
  assert.deepEqual(f.saved, []); assert.deepEqual(f.rendered, [])
  f.windowTarget.dispatchEvent(pointer('pointermove', 240)); f.windowTarget.dispatchEvent(pointer('pointerup', 250))
  assert.deepEqual(f.saved, [280])
})
test('blur, pagehide and explicit disposal persist once and detach all drag behavior', () => {
  for (const kind of ['blur', 'pagehide', 'dispose']) {
    const f = fixture(); f.windowTarget.dispatchEvent(pointer('pointermove', 235))
    if (kind === 'dispose') f.finish(); else f.windowTarget.dispatchEvent(new Event(kind))
    f.windowTarget.dispatchEvent(pointer('pointermove', 320)); f.target.dispatchEvent(pointer('lostpointercapture', 0)); f.finish()
    assert.deepEqual(f.rendered, [265]); assert.deepEqual(f.saved, [265])
  }
})
test('missed mouse release ends at last actual drag width rather than a later hover position', () => {
  const f = fixture(); f.windowTarget.dispatchEvent(pointer('pointermove', 241))
  f.windowTarget.dispatchEvent(pointer('pointermove', 330, 7, 0))
  assert.deepEqual(f.saved, [271]); assert.deepEqual(f.rendered, [271])
})
test('right panel direction, clamping and no-movement finalization retain calculated actual width', () => {
  const f = fixture(false, true); f.windowTarget.dispatchEvent(pointer('pointermove', 200)); f.windowTarget.dispatchEvent(pointer('pointerup', 100))
  assert.deepEqual(f.saved, [340])
  const untouched = fixture(); untouched.finish(); assert.deepEqual(untouched.saved, [253])
})
