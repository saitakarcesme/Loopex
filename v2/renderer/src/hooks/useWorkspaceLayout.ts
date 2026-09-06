import { useCallback, useLayoutEffect, useRef, useState, type RefObject, type SetStateAction } from 'react'
import type { BrowserState } from '../../../shared/contracts'
import { api, remember } from '../api'
import { browserAttachments } from '../panels/browserAttachmentQueue'

interface Layout { sidebar: boolean; panel: boolean }
export function useWorkspaceLayout(taskId: string | null, shell: RefObject<HTMLDivElement | null>, onError: (error: unknown) => void) {
  const [requested, setRequested] = useState<Layout>(() => ({ sidebar: remember('sidebarOpen', true), panel: remember('panelOpen', false) }))
  const [layout, setLayout] = useState(requested)
  const [settling, setSettling] = useState(false)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const changing = settling || requested.sidebar !== layout.sidebar || requested.panel !== layout.panel
  useLayoutEffect(() => {
    if (requested.sidebar === layoutRef.current.sidebar && requested.panel === layoutRef.current.panel) return
    let cancelled = false
    setSettling(true)
    // This barrier shares the renderer's attachment queue. Prior shows finish
    // before hides are acknowledged; later updates see the moving overlay state.
    void browserAttachments.enqueue(async () => {
      if (!taskId) return
      const tabs = await api<BrowserState[]>('browser:list', { taskId })
      for (const tab of tabs) {
        try { await api('browser:attach', { taskId, id: tab.id, visible: false, bounds: { x: 0, y: 0, width: 1, height: 1 } }) }
        catch (error) {
          const remaining = await api<BrowserState[]>('browser:list', { taskId })
          if (remaining.some(current => current.id === tab.id)) throw error
        }
      }
    }).then(() => {
      if (!cancelled) setLayout(requested)
    }).catch(error => {
      if (cancelled) return
      setRequested(layoutRef.current)
      setSettling(false)
      onError(error)
    })
    return () => { cancelled = true }
  }, [requested, taskId, onError])
  useLayoutEffect(() => {
    // This runs after the actual geometry commit, not merely after requesting it.
    // Interrupted/reversed transitions have their own cancellation and completion.
    let cancelled = false
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { setSettling(false); return }
    setSettling(true)
    const frame = requestAnimationFrame(() => {
      const animations = [...(shell.current?.querySelectorAll('.sidebar-container, .panel-container') || [])]
        .flatMap(element => element.getAnimations())
      void Promise.allSettled(animations.map(animation => animation.finished)).then(() => {
        if (!cancelled) setSettling(false)
      })
    })
    return () => { cancelled = true; cancelAnimationFrame(frame) }
  }, [layout, requested, taskId, shell])
  const setSidebarOpen = useCallback((value: SetStateAction<boolean>) => setRequested(current => ({ ...current, sidebar: typeof value === 'function' ? value(current.sidebar) : value })), [])
  const setPanelOpen = useCallback((value: SetStateAction<boolean>) => setRequested(current => ({ ...current, panel: typeof value === 'function' ? value(current.panel) : value })), [])
  return { sidebarOpen: layout.sidebar, panelOpen: layout.panel, setSidebarOpen, setPanelOpen, changing }
}
