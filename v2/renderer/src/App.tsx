import {
  ArrowUpRight,
  CircleAlert,
  Code2,
  Folder,
  FolderOpen,
  GitCompareArrows,
  PanelLeftOpen,
  PanelRightOpen,
  Plus,
  Search,
  ScrollText,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react'
import type { Project, Settings } from '../../shared/contracts'
import { api, isActive, persist, remember, statusLabel } from './api'
import { Composer } from './components/Composer'
import { ContextDialog } from './components/ContextDialog'
import { ArtifactPreviewProvider } from './components/ArtifactPreview'
import { TaskSurfaceContext } from './components/Markdown'
import { IconButton, Spinner } from './components/Primitives'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Transcript } from './components/Transcript'
import { useWorkspace } from './hooks/useWorkspace'
import { WorkspacePanel, type PanelTab } from './panels/WorkspacePanel'

function Notice({
  id,
  text,
  onDismiss,
}: {
  id: string
  text: string
  onDismiss: (id: string) => void
}) {
  useEffect(() => {
    const timer = setTimeout(() => onDismiss(id), 11000)
    return () => clearTimeout(timer)
  }, [id, onDismiss])
  return (
    <div className="toast" role="status">
      <CircleAlert size={16} />
      <span>{text}</span>
      <IconButton label="Dismiss notification" onClick={() => onDismiss(id)}>
        <X size={14} />
      </IconButton>
    </div>
  )
}

export function App() {
  const workspace = useWorkspace()
  const { snapshot, detail, selectedId, reportError, notify } = workspace
  const [sidebarOpen, setSidebarOpen] = useState(() => remember('sidebarOpen', true))
  const [panelOpen, setPanelOpen] = useState(() => remember('panelOpen', false))
  const [panelTab, setPanelTab] = useState<PanelTab>(() => remember('panelTab', 'files'))
  const [sidebarWidth, setSidebarWidth] = useState(() => remember('sidebarWidth', 246))
  const [panelWidth, setPanelWidth] = useState(() => remember('panelWidth', 520))
  const [settingsTab, setSettingsTab] = useState<'general' | 'connections' | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [sidebarOverlay, setSidebarOverlay] = useState(false)
  const [reviewOverlay, setReviewOverlay] = useState(false)
  const [artifactOverlay, setArtifactOverlay] = useState(false)
  const [contextTarget, setContextTarget] = useState<{ taskId: string; turnId?: string } | null>(null)
  const [filePath, setFilePath] = useState<string | undefined>(undefined)
  const [fileVersion, setFileVersion] = useState(0)
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set())
  const [suggestion, setSuggestion] = useState<{ id: string; text: string } | null>(null)
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const creating = useRef(false)
  const initialized = useRef(false)
  const task = detail?.task || snapshot?.tasks.find((task) => task.id === selectedId)
  const project = snapshot?.projects.find((project) => project.id === task?.projectId)
  const contextOpen = !!contextTarget && contextTarget.taskId === selectedId
  const overlay = !!settingsTab || searchOpen || sidebarOverlay || reviewOverlay || artifactOverlay || contextOpen
  const newTask = useCallback(
    async (projectId?: string | null) => {
      if (creating.current) return
      creating.current = true
      try {
        await workspace.createTask(projectId)
        setFilePath(undefined)
        setSuggestion(null)
        requestAnimationFrame(() => document.getElementById('prompt-input')?.focus())
      } catch (error) {
        reportError(error)
      } finally {
        creating.current = false
      }
    },
    [workspace.createTask, reportError],
  )
  useEffect(() => {
    if (!snapshot || initialized.current) return
    initialized.current = true
    if (!selectedId) {
      const previous = snapshot.tasks
        .filter((task) => !task.archived)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0]
      if (previous) workspace.selectTask(previous.id)
      else void newTask(null)
    }
  }, [snapshot, selectedId, newTask, workspace.selectTask])
  useEffect(() => {
    const preference = snapshot?.settings.theme || 'system'
    const media = matchMedia('(prefers-color-scheme: dark)')
    const update = () => {
      const next = preference === 'system' ? (media.matches ? 'dark' : 'light') : preference
      document.documentElement.dataset.theme = next
      setResolvedTheme(next)
    }
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [snapshot?.settings.theme])
  useEffect(() => {
    persist('sidebarOpen', sidebarOpen)
    persist('panelOpen', panelOpen)
    persist('panelTab', panelTab)
  }, [sidebarOpen, panelOpen, panelTab])
  useEffect(() => {
    setFilePath(undefined)
    setSuggestion(null)
    setContextTarget(null)
  }, [selectedId])
  useEffect(() => {
    if (panelOpen && selectedId)
      setOpenedPanels((current) =>
        current.has(selectedId) ? current : new Set([...current, selectedId]),
      )
  }, [panelOpen, selectedId])
  const openPanel = useCallback((tab: PanelTab) => {
    setPanelTab(tab)
    setPanelOpen(true)
  }, [])
  const openFile = useCallback(
    (path: string) => {
      setFilePath(path)
      setFileVersion((version) => version + 1)
      openPanel('files')
    },
    [openPanel],
  )
  const openProject = useCallback(async () => {
    try {
      const project = await api<Project | null>('project:open')
      if (project) {
        await workspace.refresh()
        await newTask(project.id)
      }
    } catch (error) {
      reportError(error)
    }
  }, [workspace.refresh, newTask, reportError])
  const selectTask = useCallback(
    (id: string) => {
      workspace.selectTask(id)
      setSelectionRevision((value) => value + 1)
    },
    [workspace.selectTask],
  )
  const newSidebarTask = useCallback(
    (projectId?: string | null) => {
      void newTask(projectId)
    },
    [newTask],
  )
  const openSidebarProject = useCallback(() => {
    void openProject()
  }, [openProject])
  const openSearch = useCallback(() => setSearchOpen(true), [])
  const inspectContext = useCallback((taskId: string, turnId?: string) => setContextTarget({ taskId, turnId }), [])
  const openSettings = useCallback(() => setSettingsTab('general'), [])
  const collapseSidebar = useCallback(() => setSidebarOpen(false), [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (artifactOverlay) return
      if (!(event.metaKey || event.ctrlKey)) return
      const key = event.key.toLowerCase()
      if (key === 'n') {
        event.preventDefault()
        setSettingsTab(null)
        setContextTarget(null)
        setSearchOpen(false)
        void newTask(task?.projectId)
      } else if (key === 'k') {
        event.preventDefault()
        setContextTarget(null)
        setSettingsTab(null)
        setSearchOpen((value) => !value)
      } else if (key === ',') {
        event.preventDefault()
        setContextTarget(null)
        setSearchOpen(false)
        setSettingsTab((value) => (value ? null : 'general'))
      } else if (key === 'b' && !overlay) {
        event.preventDefault()
        if (window.innerWidth <= 1080 && panelOpen) {
          setPanelOpen(false)
          setSidebarOpen(true)
        } else setSidebarOpen((value) => !value)
      } else if (key === 'j' && !overlay) {
        event.preventDefault()
        setPanelOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [newTask, task?.projectId, overlay, panelOpen, artifactOverlay])
  useEffect(() => {
    if (!window.akorith) return
    return window.akorith.onHostEvent((event) => {
      // Tool-created views are available in the panel without stealing the user's focus.
      if (event.type === 'browser:state') persist('browserHasActivity', true)
    })
  }, [])
  const saveSettings = (settings: Settings) =>
    workspace.setSnapshot((current) => (current ? { ...current, settings } : current))
  const resize = (side: 'sidebar' | 'panel', event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const start = event.clientX,
      initial = side === 'sidebar' ? sidebarWidth : panelWidth
    let width = initial
    const element = event.currentTarget
    const move = (moveEvent: PointerEvent) => {
      width = Math.round(
        Math.min(
          side === 'sidebar'
            ? 340
            : Math.max(380, window.innerWidth - (sidebarOpen ? sidebarWidth : 0) - 400),
          Math.max(
            side === 'sidebar' ? 200 : 360,
            initial + (moveEvent.clientX - start) * (side === 'sidebar' ? 1 : -1),
          ),
        ),
      )
      if (side === 'sidebar') setSidebarWidth(width)
      else setPanelWidth(width)
    }
    const finish = () => {
      element.removeEventListener('pointermove', move)
      element.removeEventListener('pointerup', finish)
      element.removeEventListener('pointercancel', finish)
      persist(side === 'sidebar' ? 'sidebarWidth' : 'panelWidth', width)
      void api('settings:update', {
        patch: side === 'sidebar' ? { sidebarWidth: width } : { panelWidth: width },
      }).catch(reportError)
    }
    element.addEventListener('pointermove', move)
    element.addEventListener('pointerup', finish)
    element.addEventListener('pointercancel', finish)
  }
  if (workspace.error)
    return (
      <div className="crash-screen">
        <div className="brand-glyph">a</div>
        <h1>Couldn’t open your workspace</h1>
        <p>{workspace.error}</p>
        <button
          className="primary-button"
          onClick={() => void workspace.refresh().catch(reportError)}
        >
          Try again
        </button>
      </div>
    )
  if (!snapshot)
    return (
      <div className="app-loading">
        <div className="brand-glyph">a</div>
        <Spinner size={18} />
        <span>Opening your workspace</span>
      </div>
    )
  return (
    <div
      className={`app-shell ${sidebarOpen ? 'sidebar-is-open' : ''} ${panelOpen ? 'panel-is-open' : ''}`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--panel-width': `${panelWidth}px`,
        } as CSSProperties
      }
    >
      {sidebarOpen ? (
        <>
          <Sidebar
            tasks={snapshot.tasks}
            projects={snapshot.projects}
            selectedId={selectedId}
            selectionRevision={selectionRevision}
            onSelect={selectTask}
            onNew={newSidebarTask}
            onOpenProject={openSidebarProject}
            onSearch={openSearch}
            onSettings={openSettings}
            onCollapse={collapseSidebar}
            onPatch={workspace.patchTask}
            onRefresh={workspace.refresh}
            onError={reportError}
            onOverlay={setSidebarOverlay}
          />
          <div
            role="separator"
            aria-label="Resize sidebar"
            aria-orientation="vertical"
            className="resize-handle sidebar-resize"
            onPointerDown={(event) => resize('sidebar', event)}
          />
        </>
      ) : null}
      <TaskSurfaceContext.Provider value={task?.id || null}>
        <ArtifactPreviewProvider
          key={`artifacts:${task?.id || 'empty'}`}
          taskId={task?.id || null}
          onOverlay={setArtifactOverlay}
        >
          <main className="main-workspace">
            <header
              className={`workspace-header titlebar-drag ${!sidebarOpen ? 'sidebar-hidden' : ''}`}
            >
              <div className="header-context">
                {!sidebarOpen ? (
                  <IconButton
                    label="Show sidebar (⌘B)"
                    onClick={() => {
                      setSidebarOpen(true)
                      if (window.innerWidth <= 1080) setPanelOpen(false)
                    }}
                  >
                    <PanelLeftOpen size={17} />
                  </IconButton>
                ) : (
                  <IconButton
                    label="Show sidebar (⌘B)"
                    className="responsive-sidebar-toggle"
                    onClick={() => setPanelOpen(false)}
                  >
                    <PanelLeftOpen size={17} />
                  </IconButton>
                )}
                <span className="header-project" title={project?.path}>
                  {project ? <Folder size={14} /> : null}
                  {project?.name || 'Workspace'}
                </span>
                {task ? (
                  <>
                    <span className="header-divider">/</span>
                    <span className="header-task" title={task.title}>
                      {task.title}
                    </span>
                  </>
                ) : null}
              </div>
              <div className="header-actions">
                {task && isActive(task.status) ? (
                  <span className="header-status">
                    <span className="live-orb" />
                    {statusLabel[task.status]}
                  </span>
                ) : null}
                {task ? <IconButton label="Inspect task context" onClick={() => inspectContext(task.id)}>
                  <ScrollText size={16} />
                </IconButton> : null}
                <IconButton
                  label="Open terminal"
                  className="quick-panel-button"
                  onClick={() => openPanel('terminal')}
                >
                  <Terminal size={16} />
                </IconButton>
                <IconButton
                  label="Review changes"
                  className="quick-panel-button"
                  onClick={() => openPanel('diff')}
                >
                  <GitCompareArrows size={16} />
                </IconButton>
                <IconButton
                  label={panelOpen ? 'Hide workspace panel (⌘J)' : 'Show workspace panel (⌘J)'}
                  className={panelOpen ? 'active' : ''}
                  onClick={() => setPanelOpen((value) => !value)}
                >
                  <PanelRightOpen size={17} />
                </IconButton>
              </div>
            </header>
            {task && detail ? (
              <div className={`conversation ${detail.messages.length ? '' : 'empty-conversation'}`}>
                {detail.messages.length || detail.pending.length ? (
                  <Transcript
                    key={`transcript:${task.id}`}
                    task={task}
                    messages={detail.messages}
                    pending={detail.pending}
                    onRespond={(requestId, response) =>
                      workspace.respond(task.id, requestId, response)
                    }
                    onOpenFile={openFile}
                    onError={reportError}
                    onOverlay={setReviewOverlay}
                    onContext={inspectContext}
                  />
                ) : (
                  <div className="welcome">
                    <div className="welcome-mark" aria-hidden="true">
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                    <div className="welcome-eyebrow">{project ? project.name : 'Your workspace'}</div>
                    <h1>
                      What would you like
                      <br />
                      to work on?
                    </h1>
                    <p>From the first thought to the finished thing.</p>
                    <div className="welcome-starters">
                      <button
                        onClick={() =>
                          setSuggestion({
                            id: crypto.randomUUID(),
                            text: 'Explore this project and explain its architecture, key files, and how to run it.',
                          })
                        }
                      >
                        <Search size={16} />
                        <span>Explore a project</span>
                        <ArrowUpRight size={13} />
                      </button>
                      <button
                        onClick={() =>
                          setSuggestion({
                            id: crypto.randomUUID(),
                            text: 'Help me find and fix a problem in this project. Start by inspecting the code and available checks.',
                          })
                        }
                      >
                        <Code2 size={16} />
                        <span>Fix a problem</span>
                        <ArrowUpRight size={13} />
                      </button>
                      <button
                        onClick={() =>
                          setSuggestion({ id: crypto.randomUUID(), text: 'I want to build ' })
                        }
                      >
                        <Plus size={16} />
                        <span>Build something</span>
                        <ArrowUpRight size={13} />
                      </button>
                    </div>
                    {!project ? (
                      <button
                        className="welcome-open-project text-button"
                        onClick={() => void openProject()}
                      >
                        <FolderOpen size={14} />
                        Open a project folder
                      </button>
                    ) : null}
                  </div>
                )}
                <Composer
                  key={`composer:${task.id}`}
                  task={task}
                  providers={snapshot.providers}
                  onPatch={(patch) => workspace.patchTask(task.id, patch)}
                  onSent={() => {
                    void workspace.readTask(task.id).catch(reportError)
                  }}
                  onError={reportError}
                  onConnections={() => setSettingsTab('connections')}
                  suggestion={suggestion}
                />
              </div>
            ) : (
              <div className="task-loading">
                <Spinner size={18} />
                <span>{workspace.loadingTask ? 'Opening task…' : 'Preparing your workspace…'}</span>
              </div>
            )}
          </main>
        </ArtifactPreviewProvider>
      </TaskSurfaceContext.Provider>
      {task && (panelOpen || openedPanels.has(task.id)) ? (
        <div
          className={`panel-container ${panelOpen ? 'open' : ''}`}
          inert={!panelOpen || undefined}
        >
          <div
            role="separator"
            aria-label="Resize workspace panel"
            aria-orientation="vertical"
            className="resize-handle panel-resize"
            onPointerDown={(event) => resize('panel', event)}
          />
          <WorkspacePanel
            key={task.id}
            task={task}
            open={panelOpen}
            active={panelTab}
            onTab={openPanel}
            onClose={() => setPanelOpen(false)}
            overlay={overlay}
            theme={resolvedTheme}
            requestedPath={filePath}
            requestVersion={fileVersion}
            onError={reportError}
          />
        </div>
      ) : null}
      {searchOpen ? (
        <SearchDialog
          tasks={snapshot.tasks}
          projects={snapshot.projects}
          onSelect={selectTask}
          onNew={() => void newTask()}
          onClose={() => setSearchOpen(false)}
        />
      ) : null}
      {settingsTab ? (
        <SettingsDialog
          snapshot={snapshot}
          initialTab={settingsTab}
          onSettings={saveSettings}
          onRefresh={workspace.refresh}
          onClose={() => setSettingsTab(null)}
          onError={reportError}
          notify={notify}
        />
      ) : null}
      {contextOpen && contextTarget ? <ContextDialog
        key={`${contextTarget.taskId}:${contextTarget.turnId || 'preview'}`}
        taskId={contextTarget.taskId}
        turnId={contextTarget.turnId}
        onClose={() => setContextTarget(null)}
      /> : null}
      <div className="toast-stack">
        {workspace.notices.map((notice) => (
          <Notice key={notice.id} {...notice} onDismiss={workspace.dismissNotice} />
        ))}
      </div>
    </div>
  )
}
