export interface LocalProfile {
  name: string;
  bio: string;
  color: 'slate' | 'blue' | 'violet' | 'green';
}
export interface ProfileSummary {
  conversations: number;
  archived: number;
  reportedTokens: number;
  reportedCostUsd: number;
  usageReports: number;
  costReports: number;
  canRestoreHistory: boolean;
}
export interface HistoryArchiveReceipt { tasks: number; projects: number; }
