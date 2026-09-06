import {
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  Folder,
  FolderInput,
  FolderPlus,
  MoreHorizontal,
  PanelLeftClose,
  Pencil,
  Pin,
  Plus,
  Search,
  Settings2,
  SquarePen,
  X,
} from 'lucide-react'
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { Project, Task } from '../../../shared/contracts'
import { api, isActive, persist, remember, statusLabel } from '../api'
import { Dialog, IconButton, Spinner } from './Primitives'
import { ProjectDialog } from './ProjectDialog'
import { groupSidebarTasks, sidebarPage, PROJECT_PAGE_SIZE, TASK_PAGE_SIZE } from './sidebarModel'

interface SidebarProps {
  tasks: Task[]
  projects: Project[]
  selectedId: string | null
  selectionRevision: number
  onSelect: (id: string) => void
  onNew: (projectId?: string | null) => void
  onOpenProject: () => void
  onSearch: () => void
  onSettings: () => void
  onCollapse: () => void
  onPatch: (id: string, patch: Partial<Task>) => Promise<unknown>
  onRefresh: () => Promise<unknown>
  onError: (error: unknown) => void
  onOverlay: (open: boolean) => void
}
export const Sidebar = memo(function Sidebar({
  tasks,
  projects,
  selectedId,
  selectionRevision,
  onSelect,
  onNew,
  onOpenProject,
  onSearch,
  onSettings,
  onCollapse,
  onPatch,
  onRefresh,
  onError,
  onOverlay,
}: SidebarProps) {
  const [collapsed, setCollapsed] = useState<string[]>(() => remember('collapsedProjects', []))
  const selectedTask = useMemo(
    () => tasks.find((task) => task.id === selectedId),
    [tasks, selectedId],
  )
  const [showArchive, setShowArchive] = useState(() => !!selectedTask?.archived)
  const [limits, setLimits] = useState<Record<string, number>>({})
  const [projectLimit, setProjectLimit] = useState(PROJECT_PAGE_SIZE)
  const scroll = useRef<HTMLDivElement>(null)
  const shouldReveal = useRef(true)
  const [menu, setMenu] = useState<Task | null>(null)
  const [projectMenu, setProjectMenu] = useState<Project | null>(null)
  const [projectDialog, setProjectDialog] = useState<Project | 'create' | null>(null)
  const [busyAction, setBusyAction] = useState(false)
  const [renaming, setRenaming] = useState<Task | null>(null)
  const [title, setTitle] = useState('')
  const projectIds = useMemo(() => new Set(projects.map((project) => project.id)), [projects])
  const groups = useMemo(
    () => groupSidebarTasks(tasks, showArchive, projectIds),
    [tasks, showArchive, projectIds],
  )
  const { pinned, loose, byProject } = groups
  const menuPinIndex = menu ? pinned.findIndex((task) => task.id === menu.id) : -1
  const selectedProjectId =
    selectedTask?.archived === showArchive && !selectedTask.pinned ? selectedTask.projectId : null
  const projectPage = sidebarPage(projects, projectLimit, selectedProjectId)

  useLayoutEffect(() => {
    if (!selectedTask) return
    setShowArchive(selectedTask.archived)
    shouldReveal.current = true
    if (selectedTask.projectId)
      setCollapsed((current) => {
        if (!current.includes(selectedTask.projectId!)) return current
        const next = current.filter((id) => id !== selectedTask.projectId)
        persist('collapsedProjects', next)
        return next
      })
  }, [selectedId, selectedTask?.projectId, selectedTask?.archived, selectionRevision])
  useLayoutEffect(() => {
    if (!shouldReveal.current) return
    const row = scroll.current?.querySelector<HTMLElement>('.task-row.selected')
    if (row && scroll.current?.clientHeight) {
      row.scrollIntoView({ block: 'nearest', inline: 'nearest' })
      shouldReveal.current = false
    }
  }, [selectedId, showArchive, collapsed, selectionRevision, projectPage.selected?.id])
  const openTaskMenu = useCallback(
    (task: Task) => {
      setMenu(task)
      onOverlay(true)
    },
    [onOverlay],
  )
  const toggleProject = (id: string) =>
    setCollapsed((current) => {
      const next = current.includes(id) ? current.filter((item) => item !== id) : [...current, id]
      persist('collapsedProjects', next)
      return next
    })
  const closeMenu = () => {
    setMenu(null)
    setProjectMenu(null)
    setProjectDialog(null)
    setRenaming(null)
    onOverlay(false)
  }
  const patch = (task: Task, patch: Partial<Task>) => {
    closeMenu()
    void onPatch(task.id, patch).catch(onError)
  }
  const movePinned = async (taskId: string, direction: -1 | 1) => {
    const index = pinned.findIndex((task) => task.id === taskId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= pinned.length || showArchive || busyAction) return
    const taskIds = pinned.map((task) => task.id)
    ;[taskIds[index], taskIds[target]] = [taskIds[target], taskIds[index]]
    setBusyAction(true)
    try {
      await api('tasks:reorderPinned', { taskIds })
      await onRefresh()
    } catch (error) {
      onError(error)
    } finally {
      setBusyAction(false)
    }
  }
  const relocateProject = async () => {
    if (!projectMenu || busyAction) return
    setBusyAction(true)
    try {
      await api<Project | null>('project:relocate', { projectId: projectMenu.id })
      await onRefresh()
      closeMenu()
    } catch (error) {
      onError(error)
    } finally {
      setBusyAction(false)
    }
  }
  const renderTask = (task: Task) => (
    <TaskRow
      key={task.id}
      task={task}
      selected={selectedId === task.id}
      onSelect={onSelect}
      onMenu={openTaskMenu}
    />
  )
  const renderTasks = (items: Task[], key: string) => {
    const page = sidebarPage(items, limits[key] ?? TASK_PAGE_SIZE, selectedId)
    return (
      <>
        {page.visible.map(renderTask)}
        {page.selected ? (
          <>
            <div className="sidebar-earlier-label">Selected older task</div>
            {renderTask(page.selected)}
          </>
        ) : null}
        {page.remaining > 0 ? (
          <button
            className="sidebar-show-more"
            onClick={() =>
              setLimits((current) => ({
                ...current,
                [key]: (current[key] ?? TASK_PAGE_SIZE) + TASK_PAGE_SIZE,
              }))
            }
          >
            Show {Math.min(TASK_PAGE_SIZE, page.remaining)} more
            <span>{page.remaining} remaining</span>
          </button>
        ) : null}
      </>
    )
  }
  return (
    <>
      <aside className="sidebar" aria-label="Workspace sidebar">
        <div className="sidebar-top titlebar-drag">
          <span className="sidebar-wordmark">
            akorith
            <span className="version-dot" />
          </span>
          <IconButton label="Hide sidebar (⌘B)" onClick={onCollapse}>
            <PanelLeftClose size={17} />
          </IconButton>
        </div>
        <div className="sidebar-actions">
          <button className="nav-action" onClick={() => onNew()}>
            <SquarePen size={17} />
            <span>New task</span>
            <kbd>⌘N</kbd>
          </button>
          <button className="nav-action" onClick={onSearch}>
            <Search size={17} />
            <span>Search tasks</span>
            <kbd>⌘K</kbd>
          </button>
        </div>
        <div className="sidebar-scroll" ref={scroll}>
          {showArchive ? (
            <div className="section-heading archive-heading">
              <span>Archived tasks</span>
              <IconButton label="Back to workspace" onClick={() => setShowArchive(false)}>
                <X size={14} />
              </IconButton>
            </div>
          ) : null}
          {pinned.length ? (
            <section className="sidebar-section">
              <div className="section-heading">
                <span>
                  <Pin size={12} />
                  Pinned
                </span>
                <span>{pinned.length}</span>
              </div>
              {renderTasks(pinned, `${showArchive}:pinned`)}
            </section>
          ) : null}
          <section className="sidebar-section">
            <div className="section-heading">
              <span>Projects</span>
              <span>
              <IconButton label="Create a new project" onClick={() => { setProjectDialog('create'); onOverlay(true) }}>
                <Plus size={15} />
              </IconButton>
              <IconButton label="Open a project folder" onClick={onOpenProject}>
                <FolderPlus size={15} />
              </IconButton>
              </span>
            </div>
            {[...projectPage.visible, ...(projectPage.selected ? [projectPage.selected] : [])].map(
              (project) => {
                const projectTasks = byProject.get(project.id) || []
                const isCollapsed = collapsed.includes(project.id)
                return (
                  <div key={project.id} className="project-group">
                    <div className="project-row">
                      <button
                        className="project-select"
                        aria-expanded={!isCollapsed}
                        onClick={() => toggleProject(project.id)}
                        onContextMenu={(event) => {
                          event.preventDefault()
                          setProjectMenu(project)
                          onOverlay(true)
                        }}
                        title={project.path}
                      >
                        {isCollapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                        <Folder size={15} />
                        <span>{project.name}</span>
                      </button>
                      <IconButton
                        className="project-more"
                        label={`Actions for project ${project.name}`}
                        onClick={() => {
                          setProjectMenu(project)
                          onOverlay(true)
                        }}
                      >
                        <MoreHorizontal size={14} />
                      </IconButton>
                      <IconButton
                        className="project-add"
                        label={`New task in ${project.name}`}
                        onClick={() => onNew(project.id)}
                      >
                        <Plus size={15} />
                      </IconButton>
                    </div>
                    {!isCollapsed ? (
                      <div className="project-tasks">
                        {projectTasks.length ? (
                          renderTasks(projectTasks, `${showArchive}:project:${project.id}`)
                        ) : (
                          <button className="project-empty" onClick={() => onNew(project.id)}>
                            Start a task <Plus size={12} />
                          </button>
                        )}
                      </div>
                    ) : null}
                  </div>
                )
              },
            )}
            {projectPage.remaining > 0 ? (
              <button
                className="sidebar-show-more"
                onClick={() => setProjectLimit((value) => value + PROJECT_PAGE_SIZE)}
              >
                Show more projects<span>{projectPage.remaining} remaining</span>
              </button>
            ) : null}
            {!projects.length ? (
              <button className="open-project-card" onClick={onOpenProject}>
                <FolderPlus size={18} />
                <span>
                  Open a project<small>Work with files on your Mac</small>
                </span>
              </button>
            ) : null}
          </section>
          {loose.length ? (
            <section className="sidebar-section">
              <div className="section-heading">
                <span>Tasks</span>
                <span>{loose.length}</span>
              </div>
              {renderTasks(loose, `${showArchive}:loose`)}
            </section>
          ) : null}
          {showArchive && !groups.count ? (
            <p className="sidebar-empty">No archived tasks.</p>
          ) : null}
        </div>
        <div className="sidebar-bottom">
          <button
            className={`nav-action ${showArchive ? 'active' : ''}`}
            onClick={() => setShowArchive((value) => !value)}
          >
            <Archive size={16} />
            <span>Archive</span>
          </button>
          <button className="nav-action" onClick={onSettings}>
            <Settings2 size={16} />
            <span>Settings</span>
            <kbd>⌘,</kbd>
          </button>
          <div className="sidebar-footnote">
            <span className="local-dot" />
            Your workspace, on your Mac
          </div>
        </div>
      </aside>
      {menu ? (
        <Dialog title="Task actions" onClose={closeMenu} className="task-menu-dialog">
          <p className="menu-task-name">{menu.title}</p>
          <div className="menu-actions">
            <button
              disabled={busyAction}
              onClick={() => {
                setRenaming(menu)
                setTitle(menu.title)
                setMenu(null)
              }}
            >
              <Pencil size={16} />
              Rename task
            </button>
            <button disabled={busyAction} onClick={() => patch(menu, { pinned: !menu.pinned })}>
              <Pin size={16} />
              {menu.pinned ? 'Unpin task' : 'Pin task'}
            </button>
            {menu.pinned && !menu.archived ? (
              <>
                <button
                  disabled={busyAction || menuPinIndex <= 0}
                  onClick={() => void movePinned(menu.id, -1)}
                >
                  <ArrowUp size={16} />
                  Move up in pinned
                </button>
                <button
                  disabled={busyAction || menuPinIndex < 0 || menuPinIndex === pinned.length - 1}
                  onClick={() => void movePinned(menu.id, 1)}
                >
                  <ArrowDown size={16} />
                  Move down in pinned
                </button>
                <p className="pinned-position" role="status">
                  {busyAction
                    ? 'Saving order…'
                    : `Position ${menuPinIndex + 1} of ${pinned.length}`}
                </p>
              </>
            ) : null}
            <button disabled={busyAction} onClick={() => patch(menu, { archived: !menu.archived })}>
              <Archive size={16} />
              {menu.archived ? 'Restore task' : 'Archive task'}
            </button>
          </div>
        </Dialog>
      ) : null}
      {projectMenu ? (
        <Dialog title="Project actions" onClose={closeMenu} className="task-menu-dialog">
          <p className="menu-task-name">{projectMenu.name}</p>
          <p className="project-menu-path">{projectMenu.path}</p>
          <div className="menu-actions">
            <button
              disabled={busyAction}
              onClick={() => {
                const id = projectMenu.id
                closeMenu()
                onNew(id)
              }}
            >
              <SquarePen size={16} />
              New task in project
            </button>
            <button disabled={busyAction} onClick={() => { setProjectDialog(projectMenu); setProjectMenu(null) }}>
              <Pencil size={16} />Rename project
            </button>
            <button disabled={busyAction} onClick={() => void relocateProject()}>
              {busyAction ? <Spinner size={16} /> : <FolderInput size={16} />}Relocate folder
            </button>
            <p className="project-menu-description">
              Choose the project's new folder location. Existing tasks stay with this project.
            </p>
          </div>
        </Dialog>
      ) : null}
      {projectDialog ? (
        <ProjectDialog project={projectDialog === 'create' ? null : projectDialog} onClose={closeMenu}
          onSaved={project => {
            const created = projectDialog === 'create'
            closeMenu()
            void onRefresh().catch(onError)
            if (created) onNew(project.id)
          }} />
      ) : null}
      {renaming ? (
        <Dialog title="Rename task" onClose={closeMenu} className="small-dialog">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              if (title.trim()) patch(renaming, { title: title.trim() })
            }}
          >
            <label className="field-label" htmlFor="task-name">
              Task name
            </label>
            <input
              id="task-name"
              autoFocus
              value={title}
              maxLength={200}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={closeMenu}>
                Cancel
              </button>
              <button className="primary-button" disabled={!title.trim()}>
                <Check size={14} />
                Save name
              </button>
            </div>
          </form>
        </Dialog>
      ) : null}
    </>
  )
})

const TaskRow = memo(function TaskRow({
  task,
  selected,
  onSelect,
  onMenu,
}: {
  task: Task
  selected: boolean
  onSelect: (id: string) => void
  onMenu: (task: Task) => void
}) {
  return (
    <div className={`task-row ${selected ? 'selected' : ''}`}>
      <button
        className="task-select"
        aria-current={selected ? 'page' : undefined}
        onClick={() => onSelect(task.id)}
        onContextMenu={(event) => {
          event.preventDefault()
          onMenu(task)
        }}
        title={task.title}
      >
        <span
          className={`task-indicator ${task.status === 'waiting' ? 'waiting' : isActive(task.status) ? 'working' : task.status}`}
          aria-label={statusLabel[task.status]}
        />
        <span className="task-title">{task.title || 'New task'}</span>
      </button>
      <IconButton
        label={`Actions for ${task.title}`}
        className="task-more"
        onClick={() => onMenu(task)}
      >
        <MoreHorizontal size={15} />
      </IconButton>
    </div>
  )
})
