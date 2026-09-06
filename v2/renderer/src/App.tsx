import {
  ArrowLeft,
  ArrowRight,
  Badge,
  Bug,
  Hammer,
  RefreshCw,
  Telescope,
  CircleAlert,
  Folder,
  GitCompareArrows,
  PanelLeftOpen,
  PanelRightOpen,
  ScrollText,
  Terminal,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { Project, Settings } from '../../shared/contracts'
import { api, isActive, persist, remember, statusLabel } from './api'
import { ResearchPage } from './pages/ResearchPage'
import { BenchmarkPage } from './pages/BenchmarkPage'
import { PluginsPage } from './pages/PluginsPage'
import { Composer } from './components/Composer'
import { ContextDialog } from './components/ContextDialog'
import { ArtifactPreviewProvider } from './components/ArtifactPreview'
import { TaskSurfaceContext } from './components/Markdown'
import { IconButton, Spinner } from './components/Primitives'
import { SearchDialog } from './components/SearchDialog'
import { SettingsDialog } from './components/SettingsDialog'
import { Sidebar } from './components/Sidebar'
import { Transcript } from './components/Transcript'
import { startResizeDrag } from './hooks/resizeDrag'
import { useWorkspaceLayout } from './hooks/useWorkspaceLayout'
import { navigationIndex, navigationShortcut } from './hooks/taskNavigationState'
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
  const [page, setPage] = useState<'chat' | 'research' | 'benchmark' | 'plugins'>('chat')
  const navigation = useMemo(() => {
    const projects = snapshot?.projects.filter(project => !project.origin) || []
    const internalIds = new Set(snapshot?.projects.filter(project => project.origin).map(project => project.id))
    const tasks = snapshot?.tasks.filter(task => !task.projectId || !internalIds.has(task.projectId) || task.pinned || (page === 'chat' && task.id === selectedId)) || []
    return { projects, tasks }
  }, [snapshot?.projects, snapshot?.tasks, selectedId, page])
  const showPage = (next: 'chat' | 'research' | 'benchmark' | 'plugins') => {
    if (next !== 'chat') { void api('browser:hideAll').catch(reportError); setPanelOpen(false) }
    setPage(next)
  }
  const shellRef = useRef<HTMLDivElement>(null)
  const { sidebarOpen, panelOpen, setSidebarOpen, setPanelOpen, changing: layoutChanging } = useWorkspaceLayout(selectedId, shellRef, reportError)
  const [panelTab, setPanelTab] = useState<PanelTab>(() => remember('panelTab', 'files'))
  const resizeCleanup = useRef<(() => void) | null>(null)
  useEffect(() => () => { resizeCleanup.current?.(); resizeCleanup.current = null }, [])
  const [sidebarWidth, setSidebarWidth] = useState(() => remember('sidebarWidth', 265))
  const [panelWidth, setPanelWidth] = useState(() => remember('panelWidth', 520))
  const [settingsTab, setSettingsTab] = useState<'general' | 'connections' | null>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [selectionRevision, setSelectionRevision] = useState(0)
  const [sidebarOverlay, setSidebarOverlay] = useState(false)
  const [reviewOverlay, setReviewOverlay] = useState(false)
  const [modelOverlay, setModelOverlay] = useState(false)
  const [artifactOverlay, setArtifactOverlay] = useState(false)
  const [contextTarget, setContextTarget] = useState<{ taskId: string; turnId?: string } | null>(null)
  const [filePath, setFilePath] = useState<string | undefined>(undefined)
  const [fileVersion, setFileVersion] = useState(0)
  const [openedPanels, setOpenedPanels] = useState<Set<string>>(() => new Set())
  const [suggestion, setSuggestion] = useState<{ id: string; text: string } | null>(null)
  const [resolvedTheme, setResolvedTheme] = useState<'dark' | 'light'>(() =>
    matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  )
  const navigationFocus = useRef<string | null>(null)
  const creating = useRef(false)
  const initialized = useRef(false)
  const task = detail?.task || snapshot?.tasks.find((task) => task.id === selectedId)
  const availableTasks = new Set(snapshot?.tasks.map(task => task.id) || [])
  const canGoBack = navigationIndex(workspace.navigation.history, -1, availableTasks) !== workspace.navigation.history.index
  const canGoForward = navigationIndex(workspace.navigation.history, 1, availableTasks) !== workspace.navigation.history.index
  const project = snapshot?.projects.find((project) => project.id === task?.projectId)
  const contextOpen = !!contextTarget && contextTarget.taskId === selectedId
  const overlay = !!settingsTab || searchOpen || sidebarOverlay || reviewOverlay || artifactOverlay || modelOverlay || contextOpen
  const newTask = useCallback(
    async (projectId?: string | null) => {
      setPage('chat')
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
      setPage('chat')
      workspace.selectTask(id)
      setSelectionRevision((value) => value + 1)
    },
    [workspace.selectTask],
  )
  const navigateTask = useCallback((direction: -1 | 1) => {
    const id = workspace.navigation.navigate(direction, new Set(snapshot?.tasks.map(task => task.id) || []))
    if (id) { navigationFocus.current = id; setSelectionRevision(value => value + 1) }
  }, [workspace.navigation.navigate, snapshot?.tasks])
  useEffect(() => {
    if (selectedId && navigationFocus.current === selectedId && detail?.task.id === selectedId) {
      document.getElementById('workspace-navigation-heading')?.focus({ preventScroll: true })
      navigationFocus.current = null
    }
  }, [selectedId, detail?.task.id])
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
  const collapseSidebar = useCallback(() => {
    document.getElementById('workspace-navigation-heading')?.focus({ preventScroll: true })
    setSidebarOpen(false)
  }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (artifactOverlay || modelOverlay) return
      const editable = event.target instanceof Element && !!event.target.closest('input, textarea, [contenteditable="true"], .xterm')
      const direction = navigationShortcut(event, editable)
      if (direction && !overlay) {
        event.preventDefault()
        navigateTask(direction)
        return
      }
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
        if (sidebarOpen && event.target instanceof Element && event.target.closest('.sidebar-container'))
          document.getElementById('workspace-navigation-heading')?.focus({ preventScroll: true })
        if (window.innerWidth <= 1080 && panelOpen) {
          setPanelOpen(false)
          setSidebarOpen(true)
        } else setSidebarOpen((value) => !value)
      } else if (key === 'j' && !overlay) {
        event.preventDefault()
        if (panelOpen && event.target instanceof Element && event.target.closest('.panel-container'))
          document.getElementById('workspace-panel-toggle')?.focus({ preventScroll: true })
        setPanelOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [newTask, task?.projectId, overlay, panelOpen, sidebarOpen, artifactOverlay, modelOverlay, navigateTask])
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
    if (event.button !== 0 || event.isPrimary === false) return
    event.preventDefault()
    resizeCleanup.current?.()
    const shell = shellRef.current
    if (shell) shell.dataset.resizing = 'true'
    const start = event.clientX
    const initial = side === 'sidebar' ? sidebarWidth : panelWidth
    resizeCleanup.current = startResizeDrag({
      target: event.currentTarget,
      windowTarget: window,
      pointerId: event.pointerId,
      initialWidth: initial,
      widthAt: clientX => Math.round(Math.min(
        side === 'sidebar' ? 340 : Math.max(380, window.innerWidth - (sidebarOpen ? sidebarWidth : 0) - 400),
        Math.max(side === 'sidebar' ? 200 : 360, initial + (clientX - start) * (side === 'sidebar' ? 1 : -1)),
      )),
      onWidth: width => { if (side === 'sidebar') setSidebarWidth(width); else setPanelWidth(width) },
      onFinish: width => {
        if (shell) delete shell.dataset.resizing
        resizeCleanup.current = null
        persist(side === 'sidebar' ? 'sidebarWidth' : 'panelWidth', width)
        void api('settings:update', {
          patch: side === 'sidebar' ? { sidebarWidth: width } : { panelWidth: width },
        }).catch(reportError)
      },
    })
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
      ref={shellRef}
      className={`app-shell ${sidebarOpen ? 'sidebar-is-open' : ''} ${panelOpen ? 'panel-is-open' : ''}`}
      style={
        {
          '--sidebar-width': `${sidebarWidth}px`,
          '--panel-width': `${panelWidth}px`,
        } as CSSProperties
      }
    >
      <div className={`sidebar-container ${sidebarOpen ? 'open' : ''}`} inert={!sidebarOpen || undefined}>
          <Sidebar
            tasks={navigation.tasks}
            projects={navigation.projects}
            activePage={page}
            onPage={showPage}
            selectedId={page === 'chat' ? selectedId : null}
            selectionRevision={selectionRevision}
            onSelect={selectTask}
            onNew={newSidebarTask}
            onOpenProject={openSidebarProject}
            onSearch={openSearch}
            onSettings={openSettings}
            onCollapse={collapseSidebar}
            canGoBack={canGoBack}
            canGoForward={canGoForward}
            onBack={() => navigateTask(-1)}
            onForward={() => navigateTask(1)}
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
      </div>
      <TaskSurfaceContext.Provider value={task?.id || null}>
        <ArtifactPreviewProvider
          key={`artifacts:${task?.id || 'empty'}`}
          taskId={task?.id || null}
          onOverlay={setArtifactOverlay}
        >
          <main className="main-workspace">
            <header
              className={`workspace-header titlebar-drag ${page === 'chat' && !detail?.messages.length ? 'empty-task-header' : ''} ${!sidebarOpen ? 'sidebar-hidden' : ''}`}
            >
              <div className="header-context" id="workspace-navigation-heading" tabIndex={-1} aria-label={page === 'chat' ? task?.title || 'Workspace' : page}>
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
                <div className={`task-history-controls ${sidebarOpen ? 'history-in-sidebar' : ''}`} aria-label="Task navigation">
                  <IconButton label="Previous task (⌘[)" disabled={!canGoBack} onClick={() => navigateTask(-1)}><ArrowLeft size={15} /></IconButton>
                  <IconButton label="Next task (⌘])" disabled={!canGoForward} onClick={() => navigateTask(1)}><ArrowRight size={15} /></IconButton>
                </div>
                <span className="header-project" title={project?.path}>
                  {project ? <Folder size={14} /> : null}
                  {page === 'chat' ? project?.name || 'Workspace' : page === 'plugins' ? 'Plugins' : page === 'research' ? 'Research' : 'Benchmark'}
                </span>
                {task && page === 'chat' ? (
                  <>
                    <span className="header-divider">/</span>
                    <span id="active-task-heading" tabIndex={-1} className="header-task" title={task.title}>
                      {task.title}
                    </span>
                  </>
                ) : null}
              </div>
              {page === 'chat' ? <div className="header-actions">
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
                  id="workspace-panel-toggle"
                  label={panelOpen ? 'Hide workspace panel (⌘J)' : 'Show workspace panel (⌘J)'}
                  className={panelOpen ? 'active' : ''}
                  onClick={() => setPanelOpen((value) => !value)}
                >
                  <PanelRightOpen size={17} />
                </IconButton>
              </div> : null}
            </header>
            {page === 'plugins' ? <PluginsPage onError={reportError} onRefresh={workspace.refresh}/> :
             page === 'research' ? <ResearchPage snapshot={{...snapshot, projects:navigation.projects}} initialProjectId={task?.projectId} onError={reportError} onOpenTask={selectTask}/> :
             page === 'benchmark' ? <BenchmarkPage snapshot={{...snapshot, projects:navigation.projects}} onError={reportError} onOpenTask={selectTask}/> : task && detail ? (
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
                    <div className="welcome-symbol" aria-hidden="true"><Badge size={54} strokeWidth={1.35} /><Terminal size={29} strokeWidth={2.1} /></div>
                    <h1>What should we work on{project ? <> in <button className="welcome-project-name" onClick={() => void openProject()}>{project.name}?</button></> : '?'}</h1>
                    <div className="welcome-starters">
                      <button onClick={() => setSuggestion({ id: crypto.randomUUID(), text: 'Explore this project and explain its architecture, key files, and how to run it.' })}>
                        <Telescope size={19} /><span>Explore and<br />understand code</span>
                      </button>
                      <button onClick={() => setSuggestion({ id: crypto.randomUUID(), text: 'I want to build a new feature, app, or tool. ' })}>
                        <Hammer size={19} /><span>Build a new feature,<br />app, or tool</span>
                      </button>
                      <button onClick={() => setSuggestion({ id: crypto.randomUUID(), text: 'Review the code in this project and suggest changes. Explain your findings before making edits.' })}>
                        <RefreshCw size={19} /><span>Review code and<br />suggest changes</span>
                      </button>
                      <button onClick={() => setSuggestion({ id: crypto.randomUUID(), text: 'Help me find and fix issues and failures in this project. Start by inspecting the code and available checks.' })}>
                        <Bug size={19} /><span>Fix issues and failures</span>
                      </button>
                    </div>
                  </div>
                )}
                <Composer
                  key={`composer:${task.id}`}
                  task={task}
                  providers={snapshot.providers}
                  projectName={project?.name}
                  onChooseProject={() => void openProject()}
                  onPatch={(patch) => workspace.patchTask(task.id, patch)}
                  onSent={() => {
                    void workspace.readTask(task.id).catch(reportError)
                  }}
                  onError={reportError}
                  onConnections={() => setSettingsTab('connections')}
                  onModelOverlay={setModelOverlay}
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
      {task ? (
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
          {(panelOpen || openedPanels.has(task.id)) ? <WorkspacePanel
            key={task.id}
            task={task}
            open={panelOpen}
            active={panelTab}
            onTab={openPanel}
            onClose={() => {
              document.getElementById('workspace-panel-toggle')?.focus({ preventScroll: true })
              setPanelOpen(false)
            }}
            overlay={overlay || layoutChanging || page !== 'chat'}
            theme={resolvedTheme}
            requestedPath={filePath}
            requestVersion={fileVersion}
            onError={reportError}
          /> : null}
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
