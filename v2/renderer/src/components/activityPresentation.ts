import type { Activity } from '../../../shared/contracts'
export function activityPresentation(activity: Pick<Activity, 'kind' | 'title' | 'detail'>): { title: string; detail?: string } {
  if (activity.kind !== 'command') return { title: activity.title, detail: activity.detail }
  const first = activity.title.split(/\r?\n/, 1)[0]
  const points = [...first]
  const shortened = points.length > 100 || activity.title !== first
  const title = shortened ? `${points.slice(0, 99).join('')}…` : first
  const detail = shortened && !activity.detail?.startsWith('Command:')
    ? `Command:\n${activity.title}${activity.detail ? `\n\n${activity.detail}` : ''}`
    : activity.detail
  return { title, detail }
}
