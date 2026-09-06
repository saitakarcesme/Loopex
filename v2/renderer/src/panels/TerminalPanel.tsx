import '@xterm/xterm/css/xterm.css'
import { Plus, Terminal as TerminalIcon, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { api, errorText, persist, remember } from '../api'
import { IconButton, Spinner } from '../components/Primitives'

export function TerminalPanel({
  taskId,
  visible,
  theme,
  onError,
}: {
  taskId: string
  visible: boolean
  theme: 'dark' | 'light'
  onError: (error: unknown) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<import('@xterm/xterm').Terminal | null>(null)
  const fitRef = useRef<import('@xterm/addon-fit').FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [ready, setReady] = useState(false)
  const [exitCode, setExitCode] = useState<number | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const onErrorRef = useRef(onError)
  onErrorRef.current = onError
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | undefined
    let observer: ResizeObserver | undefined
    let inputDisposable: { dispose(): void } | undefined
    let frame = 0
    const pending = new Map<string, string[]>()
    setReady(false)
    setExitCode(null)
    setFailure(null)
    async function connect() {
      try {
        const [{ Terminal }, { FitAddon }] = await Promise.all([
          import('@xterm/xterm'),
          import('@xterm/addon-fit'),
        ])
        if (disposed || !container.current) return
        const terminal = new Terminal({
          cursorBlink: true,
          fontFamily: '"SFMono-Regular", Menlo, monospace',
          fontSize: 12,
          lineHeight: 1.35,
          scrollback: 5000,
          theme: {
            background: theme === 'dark' ? '#191a19' : '#ffffff',
            foreground: theme === 'dark' ? '#e7e8e3' : '#292b28',
            cursor: theme === 'dark' ? '#c4c9bc' : '#373d31',
            selectionBackground: '#75886260',
          },
        })
        const fit = new FitAddon()
        terminal.loadAddon(fit)
        terminal.open(container.current)
        terminalRef.current = terminal
        fitRef.current = fit
        if (container.current.clientWidth > 0) fit.fit()
        unsubscribe = window.akorith.onHostEvent((event) => {
          if (
            event.type === 'terminal:data' &&
            typeof event.id === 'string' &&
            typeof event.data === 'string'
          ) {
            if (event.id === idRef.current) terminal.write(event.data)
            else if (!idRef.current) {
              const existing = pending.get(event.id) || []
              existing.push(event.data)
              if (existing.length > 100) existing.shift()
              pending.set(event.id, existing)
            }
          }
          if (event.type === 'terminal:exit' && event.id === idRef.current)
            setExitCode(Number(event.code ?? 0))
        })
        const existing =
          generation === 0
            ? await api<
                Array<{
                  id: string
                  taskId: string
                  output: string
                  cols: number
                  rows: number
                  exited: boolean
                  exitCode?: number
                }>
              >('terminal:list', { taskId })
            : []
        const savedId = remember<string | null>(`terminalSession.${taskId}`, null)
        const recovered =
          existing.find((session) => session.id === savedId) ||
          existing.find((session) => !session.exited) ||
          existing.at(-1)
        const session =
          recovered ||
          (await api<{ id: string }>('terminal:create', {
            taskId,
            cols: terminal.cols || 80,
            rows: terminal.rows || 24,
          }))
        if (disposed) return
        idRef.current = session.id
        persist(`terminalSession.${taskId}`, session.id)
        if (recovered?.output) terminal.write(recovered.output)
        if (recovered?.exited) setExitCode(recovered.exitCode ?? 0)
        for (const data of pending.get(session.id) || []) terminal.write(data)
        pending.clear()
        inputDisposable = terminal.onData(
          (data) =>
            void api('terminal:write', { taskId, id: session.id, data }).catch(onErrorRef.current),
        )
        observer = new ResizeObserver(() => {
          cancelAnimationFrame(frame)
          frame = requestAnimationFrame(() => {
            if (!container.current?.clientWidth || disposed) return
            fit.fit()
            void api('terminal:resize', {
              taskId,
              id: session.id,
              cols: terminal.cols,
              rows: terminal.rows,
            }).catch(() => {})
          })
        })
        observer.observe(container.current!)
        setReady(true)
      } catch (error) {
        if (!disposed) setFailure(errorText(error))
      }
    }
    void connect()
    return () => {
      disposed = true
      cancelAnimationFrame(frame)
      observer?.disconnect()
      unsubscribe?.()
      inputDisposable?.dispose()
      idRef.current = null
      terminalRef.current?.dispose()
      terminalRef.current = null
      fitRef.current = null
    }
  }, [taskId, generation])
  useEffect(() => {
    if (visible && ready) {
      fitRef.current?.fit()
      terminalRef.current?.focus()
    }
  }, [visible, ready])
  useEffect(() => {
    if (terminalRef.current)
      terminalRef.current.options.theme = {
        background: theme === 'dark' ? '#191a19' : '#ffffff',
        foreground: theme === 'dark' ? '#e7e8e3' : '#292b28',
        cursor: theme === 'dark' ? '#c4c9bc' : '#373d31',
        selectionBackground: '#75886260',
      }
  }, [theme])
  const restart = async () => {
    try {
      if (idRef.current) await api('terminal:close', { taskId, id: idRef.current })
      setGeneration((value) => value + 1)
    } catch (error) {
      onError(error)
    }
  }
  return (
    <div className="terminal-panel">
      <div className="panel-toolbar">
        <TerminalIcon size={14} />
        <span className="toolbar-filename">Terminal</span>
        {exitCode !== null ? (
          <span className="muted small">Exited · {exitCode}</span>
        ) : ready ? (
          <span className="terminal-connected">
            <span />
            Connected
          </span>
        ) : (
          <Spinner size={12} />
        )}
        <IconButton label="Start a new terminal" onClick={() => void restart()}>
          <Plus size={15} />
        </IconButton>
        <IconButton
          label="Close terminal session"
          disabled={!ready || exitCode !== null}
          onClick={() => {
            if (idRef.current)
              void api('terminal:close', { taskId, id: idRef.current })
                .then(() => {
                  setExitCode(0)
                  idRef.current = null
                })
                .catch(onError)
          }}
        >
          <X size={15} />
        </IconButton>
      </div>
      {failure ? (
        <div className="panel-error">
          {failure}
          <button className="text-button" onClick={() => void restart()}>
            Try again
          </button>
        </div>
      ) : null}
      <div className="terminal-surface" ref={container} />
    </div>
  )
}
