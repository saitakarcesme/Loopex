import { randomUUID } from 'node:crypto';
import type { Store } from './storage';
import type { Message } from '../shared/contracts';
import type { LocalProfile, ProfileSummary, HistoryArchiveReceipt } from '../shared/profile-contracts';

export const defaultProfile: LocalProfile = { name: 'Local profile', bio: '', color: 'slate' };
export function readProfile(store: Store): LocalProfile {
  const row = store.db.prepare("SELECT data FROM preferences WHERE key='localProfile'").get() as {data:string}|undefined;
  return row ? { ...defaultProfile, ...JSON.parse(row.data) } : { ...defaultProfile };
}
export function saveProfile(store: Store, input: unknown): LocalProfile {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid local profile.');
  const p = input as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 60) throw new Error('Use a name between 1 and 60 characters.');
  if (typeof p.bio !== 'string' || p.bio.length > 500) throw new Error('About you must be at most 500 characters.');
  if (!['slate','blue','violet','green'].includes(String(p.color))) throw new Error('Choose a profile color.');
  const next: LocalProfile = {name:p.name.trim(),bio:p.bio.trim(),color:p.color as LocalProfile['color']};
  store.db.prepare("INSERT INTO preferences(key,data) VALUES ('localProfile',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(next));
  return next;
}
interface ArchiveBatch { id: string; taskIds: string[]; projectIds: string[]; }
function batches(store: Store): ArchiveBatch[] {
  const row = store.db.prepare("SELECT data FROM preferences WHERE key='historyArchives'").get() as {data:string}|undefined;
  return row ? JSON.parse(row.data) : [];
}
function saveBatches(store: Store, value: ArchiveBatch[]) {
  store.db.prepare("INSERT INTO preferences(key,data) VALUES ('historyArchives',?) ON CONFLICT(key) DO UPDATE SET data=excluded.data").run(JSON.stringify(value));
}
export function archiveHistory(store: Store): HistoryArchiveReceipt {
  return store.db.transaction(() => {
    const tasks = store.tasks();
    if (tasks.some(t => ['queued','starting','running','waiting','cancelling'].includes(t.status))) throw new Error('Finish or stop active tasks before clearing history.');
    const taskIds = tasks.filter(t=>!t.archived).map(t=>t.id);
    const projectIds = store.projects().filter(p=>!p.hiddenFromSidebar && !p.origin).map(p=>p.id);
    if (!taskIds.length && !projectIds.length) return {tasks:0,projects:0};
    for (const id of taskIds) store.updateTask(id,{archived:true});
    for (const id of projectIds) {
      const project = store.project(id)!;
      store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project,hiddenFromSidebar:true}),id);
    }
    saveBatches(store,[...batches(store),{id:randomUUID(),taskIds,projectIds}]);
    return {tasks:taskIds.length,projects:projectIds.length};
  })();
}
export function restoreHistory(store: Store): HistoryArchiveReceipt {
  return store.db.transaction(() => {
    const history = batches(store), batch = history.pop();
    if (!batch) return {tasks:0,projects:0};
    let tasks=0,projects=0;
    const existing = new Set(store.tasks().map(t=>t.id));
    for (const id of batch.taskIds) if(existing.has(id)) {store.updateTask(id,{archived:false});tasks++;}
    for (const id of batch.projectIds) {
      const project=store.project(id); if(!project)continue;
      store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify({...project,hiddenFromSidebar:false}),id);projects++;
    }
    saveBatches(store,history);
    return {tasks,projects};
  })();
}
export function profileSummary(store: Store): ProfileSummary {
  const tasks=store.tasks();
  const summary:ProfileSummary={conversations:tasks.filter(t=>!t.archived).length,archived:tasks.filter(t=>t.archived).length,reportedTokens:0,reportedCostUsd:0,usageReports:0,costReports:0,canRestoreHistory:batches(store).length>0};
  const valid=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
  for (const row of store.db.prepare('SELECT data FROM messages').iterate() as Iterable<{data:string}>) {
    const m=JSON.parse(row.data) as Message;if(m.role!=='assistant'||!m.usage)continue;
    const u=m.usage; const total=valid(u.totalTokens)?u.totalTokens:valid(u.inputTokens)&&valid(u.outputTokens)?u.inputTokens+u.outputTokens:undefined;
    if(valid(total)){summary.reportedTokens+=total;summary.usageReports++;}
    if(valid(u.costUsd)){summary.reportedCostUsd+=u.costUsd;summary.costReports++;}
  }
  return summary;
}
