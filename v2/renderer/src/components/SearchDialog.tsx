import { Archive, CornerDownLeft, Folder, Search, SquarePen } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Project, Task } from '../../../shared/contracts'
import { Dialog } from './Primitives'

export function SearchDialog({
  tasks,
  projects,
  onSelect,
  onNew,
  onClose,
}: {
  tasks: Task[]
  projects: Project[]
  onSelect: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const [limit, setLimit] = useState(30)
  const list = useRef<HTMLDivElement>(null)
  const projectNames = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  )
  const matches = useMemo(() => {
    const lower = query.trim().toLowerCase()
    return tasks
      .filter(
        (task) =>
          !lower ||
          `${task.title} ${projectNames.get(task.projectId || '') || ''}`
            .toLowerCase()
            .includes(lower),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [query, tasks, projectNames])
  const results = matches.slice(0, limit)
  useEffect(() => {
    list.current
      ?.querySelector<HTMLElement>('.search-result.active')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active])
  return (
    <Dialog title="Search tasks" onClose={onClose} className="search-dialog" labelled={false}>
      <div className="search-input">
        <Search size={20} />
        <input
          aria-label="Search tasks and projects"
          autoFocus
          placeholder="Search tasks and projects…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
            setLimit(30)
          }}
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              if (active + 1 >= results.length && results.length < matches.length)
                setLimit((value) => value + 30)
              setActive((value) => Math.max(0, Math.min(matches.length - 1, value + 1)))
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault()
              setActive((value) => Math.max(0, value - 1))
            }
            if (event.key === 'Enter' && results[active]) {
              onSelect(results[active].id)
              onClose()
            }
          }}
        />
        <kbd>esc</kbd>
      </div>
      <div className="search-results" ref={list}>
        <div className="search-section-label">
          {query ? `${matches.length} matching tasks` : 'Recent tasks'}
        </div>
        {results.map((task, index) => (
          <button
            key={task.id}
            className={`search-result ${active === index ? 'active' : ''}`}
            onMouseEnter={() => setActive(index)}
            onClick={() => {
              onSelect(task.id)
              onClose()
            }}
          >
            <span className="search-result-icon">
              {task.archived ? <Archive size={16} /> : <SquarePen size={16} />}
            </span>
            <span>
              <strong>{task.title}</strong>
              <small>
                {projectNames.get(task.projectId || '') || 'Standalone task'}
                {task.archived ? ' · Archived' : ''}
              </small>
            </span>
            {index === active ? <CornerDownLeft size={14} /> : null}
          </button>
        ))}
        {matches.length > results.length ? (
          <button className="sidebar-show-more" onClick={() => setLimit((value) => value + 30)}>
            Show more results<span>{matches.length - results.length} remaining</span>
          </button>
        ) : null}
        {!results.length ? (
          <div className="search-no-results">
            <Folder size={24} />
            <p>No tasks match “{query}”</p>
          </div>
        ) : null}
      </div>
      <button
        className="search-new"
        onClick={() => {
          onClose()
          onNew()
        }}
      >
        <SquarePen size={15} />
        Start a new task<kbd>⌘N</kbd>
      </button>
    </Dialog>
  )
}
