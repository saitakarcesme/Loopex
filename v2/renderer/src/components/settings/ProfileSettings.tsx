import { Archive, ArrowUpRight, Check, Monitor, Moon, Sun, Undo2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { HistoryArchiveReceipt, LocalProfile, ProfileSummary } from '../../../../shared/profile-contracts'
import type { Settings } from '../../../../shared/contracts'
import { api, compactNumber } from '../../api'
import { Spinner } from '../Primitives'
import type { SettingsSectionProps } from './types'

export function ProfileSettings({snapshot,onSettings,onRefresh,onHistoryCleared,onError,notify,onConnections,onPlugins}: SettingsSectionProps & {onConnections:()=>void;onPlugins:()=>void}) {
  const [profile,setProfile]=useState<LocalProfile>(snapshot.profile || {name:'Local profile',bio:'',color:'slate'})
  const [summary,setSummary]=useState<ProfileSummary|null>(null)
  const [busy,setBusy]=useState(false)
  const [saved,setSaved]=useState(false)
  const refresh=()=>api<ProfileSummary>('profile:summary').then(setSummary)
  useEffect(()=>{void refresh().catch(onError)},[onError])
  const perform=async(action:()=>Promise<void>)=>{setBusy(true);try{await action()}catch(error){onError(error)}finally{setBusy(false)}}
  const theme=async(value:Settings['theme'])=>{onSettings(await api<Settings>('settings:update',{patch:{theme:value}}))}
  return <div className="local-profile-page">
    <div className="profile-identity"><div className={`profile-avatar ${profile.color}`} aria-hidden="true">{profile.name.trim().split(/\s+/).slice(0,2).map(part=>Array.from(part)[0]).join('').toUpperCase() || 'LP'}</div><div><h3>{snapshot.profile?.name || 'Local profile'}</h3><p>On this Mac · No account required</p></div></div>
    <form onSubmit={event=>{event.preventDefault();void perform(async()=>{await api<LocalProfile>('profile:save',{profile});await onRefresh();setSaved(true);notify('Local profile saved')})}}>
      <label className="profile-field">Display name<input maxLength={60} required value={profile.name} onChange={e=>{setProfile({...profile,name:e.target.value});setSaved(false)}} /></label>
      <label className="profile-field">About you<textarea maxLength={500} rows={3} value={profile.bio} onChange={e=>{setProfile({...profile,bio:e.target.value});setSaved(false)}} placeholder="A little about your work"/><span>Stored locally. This is not sent to models as an instruction.</span></label>
      <div className="profile-form-footer"><div className="profile-colors" role="group" aria-label="Profile color">{(['slate','blue','violet','green'] as const).map(color=><button key={color} type="button" className={`profile-color ${color}`} aria-label={`${color} profile color`} aria-pressed={profile.color===color} onClick={()=>{setProfile({...profile,color});setSaved(false)}}>{profile.color===color?<Check size={14}/>:null}</button>)}</div><button className="secondary-button" disabled={busy || !profile.name.trim()}>{busy?<Spinner/>:saved?<Check size={14}/>:null}{saved?'Saved':'Save profile'}</button></div>
    </form>
    <section className="profile-section"><h4>Appearance</h4><div className="profile-theme">{([{id:'system',label:'System',icon:Monitor},{id:'light',label:'Light',icon:Sun},{id:'dark',label:'Dark',icon:Moon}] as const).map(item=><button key={item.id} aria-pressed={snapshot.settings.theme===item.id} onClick={()=>void theme(item.id).catch(onError)}><item.icon size={16}/>{item.label}</button>)}</div></section>
    <section className="profile-section"><h4>Your workspace</h4><button className="profile-link" onClick={onConnections}><span>Models & connections<small>{snapshot.providers.filter(p=>p.available).length} available connections</small></span><ArrowUpRight size={16}/></button><button className="profile-link" onClick={onPlugins}><span>Plugins & skills<small>Manage capabilities for your agents</small></span><ArrowUpRight size={16}/></button></section>
    <section className="profile-section"><h4>Recorded usage</h4>{summary?<><div className="profile-stats"><div><strong>{compactNumber(summary.reportedTokens)}</strong><span>Reported tokens</span></div><div><strong>{summary.costReports?new Intl.NumberFormat('en',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(summary.reportedCostUsd):'—'}</strong><span>Reported cost</span></div><div><strong>{summary.conversations}</strong><span>Conversations</span></div></div><p className="profile-footnote">Across saved history, including archived conversations. {summary.usageReports} token reports · {summary.costReports} cost reports. Missing usage and subscription fees are not included.</p></>:<Spinner/>}</section>
    <section className="profile-section"><h4>History</h4><p className="profile-footnote">Clear conversations and projects from the sidebar. Files, connections and message history stay on this Mac; you can restore them here.</p><div className="profile-history-actions"><button className="secondary-button" disabled={busy} onClick={()=>void perform(async()=>{const result=await api<HistoryArchiveReceipt>('history:archive');await onHistoryCleared?.();await onRefresh();await refresh();notify(`${result.tasks} conversations archived. You can restore them here.`)})}><Archive size={15}/>Clear history</button><button className="secondary-button" disabled={busy || !summary?.canRestoreHistory} onClick={()=>void perform(async()=>{const result=await api<HistoryArchiveReceipt>('history:restore');await onRefresh();await refresh();notify(`${result.tasks} conversations restored`)})}><Undo2 size={15}/>Restore last clear</button></div></section>
  </div>
}
