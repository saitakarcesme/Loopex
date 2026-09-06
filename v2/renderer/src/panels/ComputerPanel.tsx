import { Camera, Monitor, PauseCircle, Play, RefreshCw, ShieldCheck, Square } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ComputerState } from '../../../shared/contracts'
import { api, errorText } from '../api'
import { EmptyState, IconButton, Spinner } from '../components/Primitives'

export function ComputerPanel({
  visible,
  onError,
}: {
  visible: boolean
  onError: (error: unknown) => void
}) {
  const [state, setState] = useState<ComputerState | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [paused, setPaused] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [bundleId, setBundleId] = useState('')
  const [capture, setCapture] = useState<string | null>(null)
  const [capturedAt, setCapturedAt] = useState<number | null>(null)
  const refresh = useCallback(async () => {
    setFailure(null)
    try {
      const next = await api<ComputerState & { paused?: boolean }>('computer:state')
      setState(next)
      setPaused(!!next.paused)
    } catch (error) {
      setFailure(errorText(error))
    }
  }, [])
  useEffect(() => {
    if (visible) void refresh()
  }, [visible, refresh])
  useEffect(
    () =>
      window.akorith.onHostEvent((event) => {
        if (event.type === 'computer:stopped') setPaused(true)
        if (event.type === 'computer:resumed') setPaused(false)
      }),
    [],
  )
  const stopControl = async () => {
    try {
      await api('computer:stop')
      setPaused(true)
    } catch (error) {
      onError(error)
    }
  }
  const resumeControl = async () => {
    setResuming(true)
    try {
      await api('computer:resume')
      await refresh()
    } catch (error) {
      onError(error)
    } finally {
      setResuming(false)
    }
  }
  const screenshot = async () => {
    setBusy(true)
    try {
      const result = await api<{ dataUrl: string }>('computer:capture', {
        bundleId: bundleId || undefined,
      })
      setCapture(result.dataUrl)
      setCapturedAt(Date.now())
    } catch (error) {
      onError(error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="computer-panel">
      <div className="panel-toolbar">
        <Monitor size={15} />
        <span className="toolbar-filename">This Mac</span>
        <IconButton label="Refresh computer state" onClick={() => void refresh()}>
          <RefreshCw size={14} />
        </IconButton>
        <button className="small-button danger-text" onClick={() => void stopControl()}>
          <Square size={11} fill="currentColor" />
          Stop control
        </button>
      </div>
      <div className="computer-content">
        {paused ? (
          <section className="computer-paused" role="status">
            <div>
              <PauseCircle size={17} />
              <h3>Computer control paused</h3>
            </div>
            <p>
              Tasks cannot use computer tools until you resume. Your macOS permissions stay the
              same.
            </p>
            <button
              className="secondary-button"
              disabled={resuming}
              onClick={() => void resumeControl()}
            >
              {resuming ? <Spinner /> : <Play size={13} />}Resume computer control
            </button>
          </section>
        ) : null}
        {failure || state?.error ? (
          <div className="panel-error">{failure || state?.error}</div>
        ) : null}
        <div className="computer-permissions">
          <div>
            <ShieldCheck size={16} />
            <span>Accessibility</span>
            <span className={`permission-state ${state?.accessibility ? 'granted' : ''}`}>
              {state?.accessibility ? 'Allowed' : state ? 'Required' : 'Checking'}
            </span>
          </div>
          <div>
            <Camera size={16} />
            <span>Screen recording</span>
            <span className={`permission-state ${state?.screenRecording ? 'granted' : ''}`}>
              {state?.screenRecording ? 'Allowed' : state ? 'Required' : 'Checking'}
            </span>
          </div>
          {state && (!state.accessibility || !state.screenRecording) ? (
            <button
              className="secondary-button"
              onClick={() =>
                void api<ComputerState>('computer:permissions').then(setState).catch(onError)
              }
            >
              Open macOS permissions
            </button>
          ) : null}
        </div>
        <label className="field-label" htmlFor="capture-target">
          Observe an application
        </label>
        <div className="capture-controls">
          <select
            id="capture-target"
            value={bundleId}
            onChange={(event) => setBundleId(event.target.value)}
          >
            <option value="">Current screen</option>
            {state?.apps
              .filter((app) => app.bundleId)
              .map((app) => (
                <option key={`${app.bundleId}-${app.pid}`} value={app.bundleId}>
                  {app.name}
                </option>
              ))}
          </select>
          <button
            className="secondary-button"
            disabled={busy || paused || !state?.screenRecording}
            onClick={() => void screenshot()}
          >
            {busy ? <Spinner /> : <Camera size={14} />}Capture
          </button>
        </div>
        {capture ? (
          <div className="computer-capture">
            <img src={capture} alt="Captured view of the selected application" />
            <div>
              Captured{' '}
              {capturedAt
                ? new Date(capturedAt).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })
                : ''}
              <span>Still image</span>
            </div>
          </div>
        ) : (
          <EmptyState icon={<Monitor size={28} />} title="See what your task sees">
            <p>
              Capture a view to inspect it here. Ask your task to interact with apps using computer
              tools.
            </p>
          </EmptyState>
        )}
        <p className="computer-hint">
          Computer tools require full access for the task. Stop control interrupts the current
          action and pauses further computer use until you resume it here.
        </p>
      </div>
    </div>
  )
}
