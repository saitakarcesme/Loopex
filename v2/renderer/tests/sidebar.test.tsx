import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project, Task } from '../../shared/contracts'
import { Sidebar } from '../src/components/Sidebar'
import { groupSidebarTasks, sidebarPage, TASK_PAGE_SIZE } from '../src/components/sidebarModel'

function task(index: number, extra: Partial<Task> = {}): Task {
  return {
    id: `task-${index}`,
    title: `Fixture task ${index}`,
    projectId: null,
    providerId: 'codex',
    model: 'test',
    effort: 'high',
    mode: 'work',
    status: 'completed',
    pinned: false,
    archived: false,
    draft: '',
    createdAt: index,
    updatedAt: index,
    nativeSessions: {},
    ...extra,
  }
}
const noop = () => {}
function render(tasks: Task[], selectedId: string | null, projects: Project[] = []) {
  return renderToStaticMarkup(
    <Sidebar
      tasks={tasks}
      projects={projects}
      selectedId={selectedId}
      selectionRevision={0}
      onSelect={noop}
      onNew={noop}
      onOpenProject={noop}
      onSearch={noop}
      onSettings={noop}
      onCollapse={noop}
      onPatch={async () => {}}
      onRefresh={async () => {}}
      onError={noop}
      onOverlay={noop}
    />,
  )
}

test('one thousand tasks mount only one page plus the selected older task', () => {
  const tasks = Array.from({ length: 1000 }, (_, index) => task(index))
  const html = render(tasks, 'task-0')
  assert.equal(html.match(/class="task-row\b/g)?.length, TASK_PAGE_SIZE + 1)
  assert.match(html, /Fixture task 0/)
  assert.match(html, /969 remaining/)
  assert.match(html, /aria-current="page"/)
})

test('selected archived task starts in the archive and remains rendered', () => {
  const html = render([task(1), task(2, { archived: true })], 'task-2')
  assert.match(html, /Archived tasks/)
  assert.match(html, /Fixture task 2/)
  assert.doesNotMatch(html, /Fixture task 1/)
})

test('a selected project beyond the initial group page is still reachable', () => {
  const projects = Array.from({ length: 50 }, (_, index) => ({
    id: `p-${index}`,
    name: `Project ${index}`,
    path: `/fixture/${index}`,
    createdAt: index,
  }))
  const tasks = projects.map((project, index) => task(index, { projectId: project.id }))
  const html = render(tasks, 'task-49', projects)
  assert.equal(html.match(/class="project-group"/g)?.length, 13)
  assert.match(html, /Fixture task 49/)
  assert.match(html, /Show more projects/)
})

test('paging and grouping retain every task for full search/order operations', () => {
  const tasks = Array.from({ length: 100 }, (_, index) =>
    task(index, { pinned: true, pinOrder: index }),
  )
  const grouped = groupSidebarTasks(tasks, false, new Set())
  assert.equal(grouped.pinned.length, 100)
  assert.equal(grouped.pinned[99].id, 'task-99')
  assert.deepEqual(
    tasks.map((item) => item.id),
    grouped.pinned.map((item) => item.id),
  )
  const first = sidebarPage(grouped.pinned, 30, 'task-99')
  assert.equal(first.visible.length, 30)
  assert.equal(first.selected?.id, 'task-99')
  const later = sidebarPage(grouped.pinned, 120, 'task-99')
  assert.equal(later.visible.length, 100)
  assert.equal(later.selected, null)
  assert.equal(later.remaining, 0)
})

test('orphan project references do not hide tasks from the sidebar', () => {
  const grouped = groupSidebarTasks([task(1, { projectId: 'missing' })], false, new Set())
  assert.equal(grouped.loose[0]?.id, 'task-1')
})
