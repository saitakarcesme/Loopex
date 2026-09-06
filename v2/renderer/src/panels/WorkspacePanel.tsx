import { FileCode2, GitCompareArrows, Globe2, Monitor, Terminal, X } from 'lucide-react'
import { useState } from 'react'
import type { Task } from '../../../shared/contracts'
import { IconButton } from '../components/Primitives'
import { BrowserPanel } from './BrowserPanel'
import { ComputerPanel } from './ComputerPanel'
import { DiffPanel } from './DiffPanel'
import { FilesPanel } from './FilesPanel'
import { TerminalPanel } from './TerminalPanel'

export type PanelTab = 'files' | 'diff' | 'terminal' | 'browser' | 'computer'
const tabs = [
  { id: 'files', label: 'Files', icon: FileCode2 },
  { id: 'diff', label: 'Changes', icon: GitCompareArrows },
  { id: 'terminal', label: 'Terminal', icon: Terminal },
  { id: 'browser', label: 'Browser', icon: Globe2 },
  { id: 'computer', label: 'Computer', icon: Monitor },
] as const
export function WorkspacePanel({
  task,
  open,
  active,
  onTab,
  onClose,
  overlay,
  theme,
  requestedPath,
  requestVersion,
  onError,
}: {
  task: Task
  open: boolean
  active: PanelTab
  onTab: (tab: PanelTab) => void
  onClose: () => void
  overlay: boolean
  theme: 'light' | 'dark'
  requestedPath?: string
  requestVersion?: number
  onError: (error: unknown) => void
}) {
  const [visited, setVisited] = useState<Set<PanelTab>>(() => new Set([active]))
  if (!visited.has(active)) setVisited((current) => new Set([...current, active]))
  return (
    <aside className="workspace-panel" aria-label="Workspace tools">
      <div className="panel-tabbar titlebar-drag" role="tablist" aria-label="Workspace panels">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={`panel-tab-${task.id}-${tab.id}`}
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`panel-${task.id}-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            className={active === tab.id ? 'selected' : ''}
            title={tab.label}
            onClick={() => onTab(tab.id)}
            onKeyDown={(event) => {
              const index = tabs.findIndex((item) => item.id === active)
              if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
                event.preventDefault()
                const next =
                  tabs[(index + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length]
                onTab(next.id)
                document.getElementById(`panel-tab-${task.id}-${next.id}`)?.focus()
              }
            }}
          >
            <tab.icon size={15} />
            <span>{tab.label}</span>
          </button>
        ))}
        <IconButton label="Close workspace panel (⌘J)" onClick={onClose}>
          <X size={15} />
        </IconButton>
      </div>
      {tabs.map((tab) =>
        visited.has(tab.id) ? (
          <div
            key={tab.id}
            id={`panel-${task.id}-${tab.id}`}
            role="tabpanel"
            aria-labelledby={`panel-tab-${task.id}-${tab.id}`}
            className="panel-tab-content"
            hidden={active !== tab.id}
          >
            {tab.id === 'files' ? (
              <FilesPanel
                task={task}
                requestedPath={requestedPath}
                requestVersion={requestVersion}
                onError={onError}
              />
            ) : tab.id === 'diff' ? (
              <DiffPanel task={task} visible={open && active === 'diff'} onError={onError} />
            ) : tab.id === 'terminal' ? (
              <TerminalPanel
                taskId={task.id}
                visible={open && active === 'terminal'}
                theme={theme}
                onError={onError}
              />
            ) : tab.id === 'browser' ? (
              <BrowserPanel
                taskId={task.id}
                visible={open && active === 'browser'}
                overlay={overlay}
                onError={onError}
              />
            ) : (
              <ComputerPanel visible={open && active === 'computer'} onError={onError} />
            )}
          </div>
        ) : null,
      )}
    </aside>
  )
}
