import type { Activity } from '../../../shared/contracts'
// Only exact host-tool identifiers have presentation labels; plugin and provider names remain intact.
const hostActionLabels: Readonly<Record<string, string>> = Object.freeze({
  files_list: 'List files', files_read: 'Read file', files_image: 'View image',
  files_write: 'Write file', files_search: 'Search files',
  git_status: 'Check Git status', git_diff: 'View Git diff', git_stage: 'Update Git staging',
  terminal_execute: 'Run command', preview_start: 'Start preview', preview_stop: 'Stop preview',
  browser_list: 'List browser tabs', browser_open: 'Open browser', browser_navigate: 'Navigate browser',
  browser_snapshot: 'Inspect page', browser_click: 'Click page element', browser_type: 'Type in page',
  browser_key: 'Press browser key', browser_scroll: 'Scroll page', browser_screenshot: 'Capture browser screenshot',
  computer_state: 'Check computer access', computer_select: 'Select app', computer_snapshot: 'Inspect app',
  computer_capture: 'Capture app screenshot', computer_click: 'Click in app', computer_type: 'Type in app',
  computer_key: 'Press app key', computer_stop: 'Stop computer control',
})
export function activityPresentation(activity: Pick<Activity, 'kind' | 'title' | 'detail'>): { title: string; detail?: string } {
  if (activity.kind !== 'command') {
    const name = activity.title.startsWith('akorith_') ? activity.title.slice('akorith_'.length) : activity.title
    const title = Object.hasOwn(hostActionLabels, name) ? hostActionLabels[name] : activity.title
    return { title, detail: activity.detail }
  }
  const first = activity.title.split(/\r?\n/, 1)[0]
  const points = [...first]
  const shortened = points.length > 100 || activity.title !== first
  const title = shortened ? `${points.slice(0, 99).join('')}…` : first
  const detail = shortened && !activity.detail?.startsWith('Command:')
    ? `Command:\n${activity.title}${activity.detail ? `\n\n${activity.detail}` : ''}`
    : activity.detail
  return { title, detail }
}
