import type { AppSnapshot, Settings } from '../../../../shared/contracts'
export interface SettingsSectionProps {
  snapshot: AppSnapshot
  onSettings: (settings: Settings) => void
  onRefresh: () => Promise<unknown>
  onError: (error: unknown) => void
  onHistoryCleared?: () => Promise<void>
  notify: (text: string) => void
}
