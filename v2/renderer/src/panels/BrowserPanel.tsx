import { ArrowLeft, ArrowRight, ExternalLink, Globe2, Play, Plus, RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { BrowserState } from '../../../shared/contracts'
import { browserAttachments } from './browserAttachmentQueue'
import { api, persist, remember } from '../api'
import { EmptyState, IconButton, Spinner } from '../components/Primitives'

const replaceTab = (current: BrowserState[], next: BrowserState) =>
  current.some((tab) => tab.id === next.id)
    ? current.map((tab) => (tab.id === next.id ? next : tab))
    : [...current, next]

export function BrowserPanel({
  taskId,
  visible,
  overlay,
  onError,
}: {
  taskId: string
  visible: boolean
  overlay: boolean
  onError: (error: unknown) => void
}) {
  const [tabs, setTabs] = useState<BrowserState[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [address, setAddress] = useState('')
  const [previewBusy, setPreviewBusy] = useState(false)
  const attachmentQueued = useRef(false)
  const attachmentDirty = useRef(false)
  const disposedRef = useRef(false)
  const surface = useRef<HTMLDivElement>(null)
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  const selectedRef = useRef(selected)
  selectedRef.current = selected
  const state = tabs.find((tab) => tab.id === selected)
  const visibleRef = useRef(visible && !overlay)
  visibleRef.current = visible && !overlay
  const handleErrorRef = useRef(onError)
  handleErrorRef.current = onError
  useEffect(() => {
    let disposed = false
    disposedRef.current = false
    const unsubscribe = window.akorith.onHostEvent((event) => {
      if (event.type === 'browser:closed' && event.taskId === taskId) {
        setTabs((current) => {
          const remaining = current.filter((tab) => tab.id !== event.id)
          if (selectedRef.current === event.id) setSelected(remaining[0]?.id || null)
          return remaining
        })
        return
      }
      if (event.type !== 'browser:state') return
      const next = event.state as BrowserState
      if (next.taskId !== taskId) return
      setTabs((current) => replaceTab(current, next))
      if (!selectedRef.current) setSelected(next.id)
    })
    void api<BrowserState[]>('browser:list', { taskId })
      .then((existing) => {
        if (disposed) return
        setTabs((current) => {
          const joined = new Map([...existing, ...current].map((tab) => [tab.id, tab]))
          return Array.from(joined.values())
        })
        const saved = remember<string | null>(`browserTab.${taskId}`, null)
        setSelected(
          (current) =>
            current || (existing.some((tab) => tab.id === saved) ? saved : existing[0]?.id || null),
        )
      })
      .catch(handleErrorRef.current)
    return () => {
      disposed = true
      unsubscribe()
      disposedRef.current = true
      const closingTabs = tabsRef.current
      void browserAttachments.enqueue(async () => {
        for (const tab of closingTabs) await api('browser:attach', {
          taskId, id: tab.id, visible: false, bounds: { x: 0, y: 0, width: 1, height: 1 },
        }).catch(() => {})
      })
    }
  }, [taskId])
  useEffect(() => {
    setAddress(state?.url === 'about:blank' ? '' : state?.url || '')
    persist(`browserTab.${taskId}`, selected)
  }, [state?.url, selected, taskId])
  const attach = useCallback((): void => {
    if (disposedRef.current) return
    if (attachmentQueued.current) { attachmentDirty.current = true; return }
    attachmentQueued.current = true
    void browserAttachments.enqueue(async () => {
      if (disposedRef.current) return
      const bounds = surface.current?.getBoundingClientRect()
      for (const tab of tabsRef.current) {
        const show =
          tab.id === selectedRef.current &&
          visibleRef.current &&
          !!bounds &&
          bounds.width > 0 &&
          bounds.height > 0 &&
          tab.url !== 'about:blank'
        await api('browser:attach', {
          taskId,
          id: tab.id,
          visible: show,
          bounds: bounds
            ? {
                x: Math.round(bounds.x),
                y: Math.round(bounds.y),
                width: Math.max(1, Math.round(bounds.width)),
                height: Math.max(1, Math.round(bounds.height)),
              }
            : { x: 0, y: 0, width: 1, height: 1 },
        }).catch(() => {})
      }
    }).finally(() => {
      attachmentQueued.current = false
      if (attachmentDirty.current) { attachmentDirty.current = false; attach() }
    }).catch(() => {})
  }, [taskId])
  useLayoutEffect(() => {
    attach()
  }, [attach, visible, overlay, selected, state?.url, tabs.length])
  useEffect(() => {
    if (!surface.current) return
    const observer = new ResizeObserver(attach)
    observer.observe(surface.current)
    window.addEventListener('resize', attach)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', attach)
    }
  }, [attach])
  const create = async (url?: string) => {
    try {
      const next = await api<BrowserState>('browser:create', { taskId, url })
      setTabs((current) => replaceTab(current, next))
      setSelected(next.id)
    } catch (error) {
      onError(error)
    }
  }
  const navigate = async () => {
    if (!address.trim()) return
    const url = /^(https?:|about:)/i.test(address)
      ? address.trim()
      : /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(address)
        ? `http://${address.trim()}`
        : `https://${address.trim()}`
    try {
      if (selected) await api('browser:navigate', { taskId, id: selected, url })
      else await create(url)
    } catch (error) {
      onError(error)
    }
  }
  const action = (action: 'back' | 'forward' | 'reload') => {
    if (selected) void api('browser:action', { taskId, id: selected, action }).catch(onError)
  }
  const close = async (id: string) => {
    try {
      await api('browser:close', { taskId, id })
      setTabs((current) => current.filter((tab) => tab.id !== id))
      if (selected === id) setSelected(tabs.find((tab) => tab.id !== id)?.id || null)
    } catch (error) {
      onError(error)
    }
  }
  const preview = async () => {
    setPreviewBusy(true)
    try {
      const result = await api<{ url: string }>('preview:start', { taskId })
      await create(result.url)
    } catch (error) {
      onError(error)
    } finally {
      setPreviewBusy(false)
    }
  }
  return (
    <div className="browser-panel">
      <div className="browser-tabs">
        {tabs.map((tab) => (
          <div key={tab.id} className={`browser-tab ${selected === tab.id ? 'selected' : ''}`}>
            <button onClick={() => setSelected(tab.id)}>
              {tab.loading ? <Spinner size={11} /> : <Globe2 size={12} />}
              <span>{tab.title || (tab.url === 'about:blank' ? 'New tab' : tab.url)}</span>
            </button>
            <IconButton label={`Close ${tab.title || 'tab'}`} onClick={() => void close(tab.id)}>
              <X size={11} />
            </IconButton>
          </div>
        ))}
        <IconButton label="New browser tab" onClick={() => void create()}>
          <Plus size={14} />
        </IconButton>
      </div>
      <form
        className="browser-addressbar"
        onSubmit={(event) => {
          event.preventDefault()
          void navigate()
        }}
      >
        <IconButton label="Go back" disabled={!state?.canGoBack} onClick={() => action('back')}>
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton
          label="Go forward"
          disabled={!state?.canGoForward}
          onClick={() => action('forward')}
        >
          <ArrowRight size={14} />
        </IconButton>
        <IconButton label="Reload page" disabled={!selected} onClick={() => action('reload')}>
          {state?.loading ? <Spinner size={13} /> : <RefreshCw size={13} />}
        </IconButton>
        <input
          aria-label="Browser address"
          placeholder="Enter a URL or localhost address"
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          onFocus={(event) => event.target.select()}
        />
        <IconButton
          label="Open page in default browser"
          disabled={!state || !/^https?:/.test(state.url)}
          onClick={() => state && void api('app:openExternal', { url: state.url }).catch(onError)}
        >
          <ExternalLink size={13} />
        </IconButton>
      </form>
      {state?.error ? <div className="browser-error">{state.error}</div> : null}
      <div className="browser-surface" ref={surface}>
        {!state || state.url === 'about:blank' ? (
          <EmptyState icon={<Globe2 size={30} />} title="A browser for your work">
            <p>
              Open a website above, or start a preview of this project. Your task can use the same
              browser.
            </p>
            <button
              className="secondary-button"
              disabled={previewBusy}
              onClick={() => void preview()}
            >
              {previewBusy ? <Spinner /> : <Play size={14} />}Start project preview
            </button>
          </EmptyState>
        ) : null}
      </div>
      <div className="panel-footnote">
        <span className="local-dot" />
        {state?.loading
          ? 'Loading page…'
          : state
            ? 'You and your task share this browser'
            : 'Isolated workspace browser'}
      </div>
    </div>
  )
}
