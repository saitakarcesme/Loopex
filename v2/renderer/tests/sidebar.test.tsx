import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Project, Task } from '../../shared/contracts'
import { Sidebar, ProjectTaskDisclosure } from '../src/components/Sidebar'
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

test('pinned projects appear once above ordinary projects with their children and independent task pins', () => {
  const projects: Project[] = [
    { id: 'ordinary', name: 'Ordinary project', path: '/fixture/a', createdAt: 1 },
    { id: 'pinned', name: 'Pinned project', path: '/fixture/b', createdAt: 2, pinned: true },
  ];
  const tasks = [task(1, { projectId: 'pinned' }), task(2, { projectId: 'pinned', pinned: true }), task(3, { projectId: 'ordinary' })];
  const html = render(tasks, 'task-1', projects);
  assert.ok(html.indexOf('>Pinned project</span>') < html.indexOf('>Projects</span>'));
  assert.ok(html.indexOf('Fixture task 1') < html.indexOf('>Projects</span>'));
  assert.equal(html.match(/>Pinned project<\/span>/g)?.length, 1);
  assert.equal(html.match(/Fixture task 2<\/span>/g)?.length, 1, 'task pin stays independent without duplicate child');
  const unpinned = render(tasks, 'task-1', projects.map(project => ({ ...project, pinned: false })));
  assert.ok(unpinned.indexOf('>Pinned project</span>') > unpinned.indexOf('>Projects</span>'));
});

test('pinned project paging retains selected older project and archive only renders archived child tasks', () => {
  const projects: Project[] = Array.from({ length: 20 }, (_, index) => ({ id: `pin-${index}`, name: `Pinned ${index}`, path: `/fixture/${index}`, createdAt: index, pinned: true }));
  const tasks = [task(1, { projectId: 'pin-19', archived: true }), task(2, { projectId: 'pin-19' })];
  const html = render(tasks, 'task-1', projects);
  assert.equal(html.match(/class="project-group"/g)?.length, 13);
  assert.match(html, /Show more pinned projects/);
  assert.match(html, /Fixture task 1/);
  assert.doesNotMatch(html, /Fixture task 2/);
  assert.match(html, /Archived tasks/);
});

test('project disclosure retains children for reversible exit while removing collapsed content from focus and accessibility', () => {
  const children = <button>Child task</button>;
  const closed = renderToStaticMarkup(<ProjectTaskDisclosure projectId="p" open={false}>{children}</ProjectTaskDisclosure>);
  assert.match(closed, /id="project-children-p"/);
  assert.match(closed, /aria-hidden="true"/);
  assert.match(closed, /inert=""/);
  assert.match(closed, /Child task/);
  const open = renderToStaticMarkup(<ProjectTaskDisclosure projectId="p" open>{children}</ProjectTaskDisclosure>);
  assert.match(open, /project-disclosure is-open/);
  assert.match(open, /aria-hidden="false"/);
  assert.doesNotMatch(open, /inert=/);
});

test('project disclosure trigger names its own child region and profile never fabricates an account identity', () => {
  const html = render([], null, [{ id: 'p', name: 'Project', path: '/fixture', createdAt: 1 }]);
  assert.match(html, /aria-controls="project-children-p"/);
  assert.match(html, /aria-label="Open profile: Local profile"/);
  assert.doesNotMatch(html, /Pull requests|Scheduled|Notifications/);
});
