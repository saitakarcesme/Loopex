import { ArrowLeft, ArrowUpRight, Check, FlaskConical, Play, Plus, RefreshCw, Square, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot } from '../../../shared/contracts'
import type { ResearchDetail, ResearchExperiment, ResearchStudy } from '../../../main/research-types'
import { api, errorText } from '../api'
import { IconButton, Spinner } from '../components/Primitives'

export interface ResearchPageProps { snapshot: AppSnapshot; initialProjectId?: string | null; onError: (error: unknown) => void; onOpenTask: (taskId: string) => void }
const date = (value: number) => new Date(value).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
const duration = (value: number) => value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
const statusLabels: Record<ResearchStudy['status'], string> = { idle: 'Ready', running: 'Running', stopping: 'Stopping', paused: 'Paused', completed: 'Completed', failed: 'Failed' }

export function ResearchPage({ snapshot, initialProjectId, onError, onOpenTask }: ResearchPageProps) {
  const [studies, setStudies] = useState<ResearchStudy[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [detail, setDetail] = useState<ResearchDetail | null>(null)
  const [creating, setCreating] = useState(false)
  const [loading, setLoading] = useState(true)
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [limit, setLimit] = useState(40)
  const selectedRef = useRef(selected), generation = useRef(0), mounted = useRef(true)
  selectedRef.current = selected
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const list = await api<ResearchStudy[]>('research:list')
      const id = selectedRef.current && list.some(study => study.id === selectedRef.current) ? selectedRef.current : list[0]?.id || null
      const next = id ? await api<ResearchDetail>('research:read', { studyId: id }) : null
      if (!mounted.current || current !== generation.current) return
      setStudies(list); setSelected(id); setDetail(next); setFailure(null)
    } catch (error) { if (mounted.current && current === generation.current) setFailure(errorText(error)) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true
    void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.akorith?.onEvent(event => {
      if (event.type !== 'changed') return
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void refresh() }, 180)
    })
    return () => { mounted.current = false; generation.current++; clearTimeout(timer); off?.() }
  }, [refresh])
  const select = async (id: string) => {
    selectedRef.current = id; setSelected(id); setCreating(false); setDetail(null); setFailure(null)
    const current = ++generation.current
    try { const next = await api<ResearchDetail>('research:read', { studyId: id }); if (mounted.current && current === generation.current) setDetail(next) }
    catch (error) { if (mounted.current && current === generation.current) setFailure(errorText(error)) }
  }
  const run = async (command: 'research:start' | 'research:stop', id: string) => {
    if (busy === command) return
    setBusy(command); setFailure(null)
    try {
      await api<ResearchDetail>(command, { studyId: id })
      await refresh()
    } catch (error) { if (mounted.current) setFailure(errorText(error)); else onError(error) }
    finally { if (mounted.current) setBusy(null) }
  }
  return <section className="lab-page" aria-label="Research"><div className="lab-page-inner">
    <header className="lab-page-header"><div className="lab-page-heading"><h1>Research</h1><p>Test a hypothesis, measure the result, and keep what improves it.</p></div><div className="lab-page-actions"><IconButton label="Refresh research" onClick={() => void refresh()}><RefreshCw size={15} /></IconButton><button className="primary-button" onClick={() => setCreating(true)}><Plus size={14} />New study</button></div></header>
    {failure ? <p className="lab-error" role="alert">{failure}</p> : null}
    {creating ? <ResearchForm snapshot={snapshot} initialProjectId={initialProjectId} onCancel={() => setCreating(false)} onCreated={async study => { selectedRef.current = study.id; setSelected(study.id); setCreating(false); await refresh() }} /> : loading ? <div className="lab-inline-state" role="status"><Spinner size={15} />Loading studies…</div> : !studies.length ? <div className="lab-empty"><FlaskConical size={36} strokeWidth={1.2} /><h2>A better result starts with a baseline</h2><p>Choose a project, define a measurable goal, and let your connection run a bounded series of experiments.</p><button className="secondary-button" onClick={() => setCreating(true)}><Plus size={14} />Create a study</button></div> : <div className="lab-layout">
      <nav className="lab-run-nav" aria-label="Research studies"><div className="lab-run-nav-title"><span>Studies</span><span>{studies.length}</span></div>{studies.slice(0, limit).map(study => <button key={study.id} className={`lab-run-item ${selected === study.id ? 'selected' : ''}`} aria-current={selected === study.id ? 'page' : undefined} onClick={() => void select(study.id)}><strong>{study.goal}</strong><span className="lab-run-item-meta"><span>{statusLabels[study.status]}</span><time>{date(study.updatedAt)}</time></span></button>)}{studies.length > limit ? <button className="text-button" onClick={() => setLimit(value => value + 40)}>Show more studies</button> : null}</nav>
      {detail?.study.id === selected ? <ResearchStudyDetail detail={detail} snapshot={snapshot} busy={busy} onStart={() => void run('research:start', detail.study.id)} onStop={() => void run('research:stop', detail.study.id)} onOpenTask={onOpenTask} onUpdated={() => { void refresh() }} /> : <div className="lab-inline-state" role="status"><Spinner size={15} />Opening study…</div>}
    </div>}
  </div></section>
}

export function researchFormDefaults(snapshot: AppSnapshot, initialProjectId?: string | null) {
  const provider = snapshot.providers.find(item => item.available && item.authenticated !== false && item.models.length > 0)
  return { projectId: snapshot.projects.some(project => project.id === initialProjectId) ? initialProjectId! : '', choice: provider ? `${provider.id}:${provider.models[0].id}` : '' }
}

function ResearchForm({ snapshot, initialProjectId, onCancel, onCreated }: { snapshot: AppSnapshot; initialProjectId?: string | null; onCancel: () => void; onCreated: (study: ResearchStudy) => Promise<void> }) {
  const [projectId, setProjectId] = useState(() => researchFormDefaults(snapshot, initialProjectId).projectId), [goal, setGoal] = useState(''), [hypothesis, setHypothesis] = useState('')
  const [metric, setMetric] = useState(''), [direction, setDirection] = useState<'minimize' | 'maximize'>('minimize')
  const [command, setCommand] = useState(''), [args, setArgs] = useState(''), [protectedPaths, setProtectedPaths] = useState(''), [timeoutSeconds, setTimeoutSeconds] = useState(60)
  const [maxExperiments, setMaxExperiments] = useState(5), [budgetMinutes, setBudgetMinutes] = useState(20), [choice, setChoice] = useState(() => researchFormDefaults(snapshot, initialProjectId).choice)
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<string | null>(null)
  const modelChoices = snapshot.providers.flatMap(provider => provider.models.map(model => ({ provider, model, key: `${provider.id}:${model.id}` })))
  const selected = modelChoices.find(item => item.key === choice)
  return <form className="lab-form" onSubmit={event => {
    event.preventDefault()
    if (busy || !selected) return
    setBusy(true); setFailure(null)
    void api<ResearchStudy>('research:create', { projectId, goal: goal.trim(), hypothesis: hypothesis.trim(), metric: metric.trim(), direction, evaluator: { command: command.trim(), args: args.split('\n').filter(value => value.length > 0), timeoutMs: timeoutSeconds * 1000, protectedPaths: protectedPaths.split('\n').map(value => value.trim()).filter(Boolean) }, maxExperiments, budgetMinutes, providerId: selected.provider.id, model: selected.model.id })
      .then(onCreated).catch(error => setFailure(errorText(error))).finally(() => setBusy(false))
  }}>
    <div className="lab-form-header"><button type="button" className="text-button" onClick={onCancel}><ArrowLeft size={13} />All studies</button><h2>New research study</h2><p>The first experiment establishes a baseline. Later experiments run in detached Git worktrees and are evaluated against the same protocol.</p></div>
    {failure ? <p className="lab-error" role="alert">{failure}</p> : null}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}>
      <div className="lab-field"><label htmlFor="research-goal">Goal</label><input id="research-goal" value={goal} onChange={event => setGoal(event.target.value)} required maxLength={4000} placeholder="Reduce the time it takes to build this project" /></div>
      <div className="lab-field"><label htmlFor="research-hypothesis">Initial hypothesis</label><textarea id="research-hypothesis" value={hypothesis} onChange={event => setHypothesis(event.target.value)} required maxLength={8000} placeholder="Describe the change you want to investigate and why it may help." /></div>
      <div className="lab-fields-row"><div className="lab-field"><label htmlFor="research-project">Project</label><select id="research-project" value={projectId} required onChange={event => setProjectId(event.target.value)}><option value="">Choose a project</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><small>A clean Git working tree is required.</small></div><div className="lab-field"><label htmlFor="research-model">Model and connection</label><select id="research-model" value={choice} required onChange={event => setChoice(event.target.value)}><option value="">Choose a model</option>{snapshot.providers.map(provider => <optgroup key={provider.id} label={`${provider.name} · ${provider.connectionLabel}`} disabled={!provider.available || provider.authenticated === false}>{provider.models.map(model => <option key={model.id} value={`${provider.id}:${model.id}`}>{model.name}</option>)}</optgroup>)}</select></div></div>
      <div className="lab-fields-row"><div className="lab-field"><label htmlFor="research-metric">Metric name</label><input id="research-metric" value={metric} onChange={event => setMetric(event.target.value)} required placeholder="build_seconds" /></div><div className="lab-field"><label htmlFor="research-direction">A better result is</label><select id="research-direction" value={direction} onChange={event => setDirection(event.target.value as typeof direction)}><option value="minimize">Lower</option><option value="maximize">Higher</option></select></div></div>
      <div className="lab-field"><label htmlFor="research-command">Evaluator executable</label><input id="research-command" value={command} onChange={event => setCommand(event.target.value)} required placeholder="python3" /><small>Runs locally as a program and arguments. Its final stdout line must be JSON containing a finite numeric value for your metric.</small></div>
      <div className="lab-field"><label htmlFor="research-args">Evaluator arguments</label><textarea id="research-args" value={args} onChange={event => setArgs(event.target.value)} placeholder={'scripts/measure.py\n--json'} rows={3} /><small>One argument per line. Shell pipes and redirection are not interpreted.</small></div>
      <div className="lab-field"><label htmlFor="research-dependencies">Evaluator dependency files · optional</label><textarea id="research-dependencies" value={protectedPaths} onChange={event => setProtectedPaths(event.target.value)} rows={3} placeholder={'benchmark/helpers.js\nbenchmark/config.json'} /><small>One project-relative file per line. Include every helper and configuration file that determines the score. These files are fingerprinted and protected; target implementation files remain editable. Dependencies are not discovered automatically.</small></div>
      <div className="lab-fields-row"><div className="lab-field"><label htmlFor="research-count">Maximum experiments</label><input id="research-count" type="number" min={1} max={20} value={maxExperiments} onChange={event => setMaxExperiments(Number(event.target.value))} required /><small>Includes the baseline.</small></div><div className="lab-field"><label htmlFor="research-budget">Time budget · minutes</label><input id="research-budget" type="number" min={1} max={120} value={budgetMinutes} onChange={event => setBudgetMinutes(Number(event.target.value))} required /></div></div>
      <div className="lab-field"><label htmlFor="research-timeout">Evaluator timeout · seconds</label><input id="research-timeout" type="number" min={1} max={300} value={timeoutSeconds} onChange={event => setTimeoutSeconds(Number(event.target.value))} required /></div>
    </fieldset>
    <div className="lab-form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy || !selected?.provider.available || selected.provider.authenticated === false || !projectId}>{busy ? <Spinner size={13} /> : <Plus size={13} />}Create study</button></div>
  </form>
}

export function ResearchStudyDetail({ detail, snapshot, busy, onStart, onStop, onOpenTask, onUpdated }: { detail: ResearchDetail; snapshot: AppSnapshot; busy: string | null; onStart: () => void; onStop: () => void; onOpenTask: (id: string) => void; onUpdated: (detail: ResearchDetail) => void }) {
  const { study, experiments } = detail
  const running = study.status === 'running' || study.status === 'stopping'
  const baseline = experiments.find(experiment => experiment.kind === 'baseline')?.measurement?.value
  const measured = experiments.filter(experiment => experiment.status === 'completed' && experiment.measurement?.value !== null && experiment.measurement?.value !== undefined)
  const best = measured.reduce<number | null>((best, experiment) => best === null ? experiment.measurement!.value : study.direction === 'minimize' ? Math.min(best, experiment.measurement!.value!) : Math.max(best, experiment.measurement!.value!), null)
  return <article className="lab-detail"><header className="lab-detail-header"><div><h2>{study.goal}</h2><p>{study.hypothesis}</p></div><span className="lab-status" data-state={study.status}><span className="lab-status-dot" />{statusLabels[study.status]}</span></header>
    <div className="lab-page-actions">{running ? <button className="secondary-button" disabled={study.status === 'stopping' || busy === 'research:stop'} onClick={onStop}><Square size={12} />Stop study</button> : <button className="primary-button" disabled={!!busy || experiments.length >= study.maxExperiments || study.elapsedMs >= study.budgetMinutes * 60000} onClick={onStart}><Play size={13} />{experiments.length ? 'Continue research' : 'Run baseline and experiments'}</button>}</div>
    {study.error ? <p className="lab-error" role="alert">{study.error}</p> : null}
    <dl className="lab-config"><div><dt>Project</dt><dd>{snapshot.projects.find(project => project.id === study.projectId)?.name || 'Project unavailable'}</dd></div><div><dt>Model</dt><dd>{study.providerId} · {study.model}</dd></div><div><dt>Metric</dt><dd>{study.metric} · {study.direction === 'minimize' ? 'lower is better' : 'higher is better'}</dd></div><div><dt>Baseline</dt><dd>{baseline ?? 'Not measured'}</dd></div><div><dt>Best measured value</dt><dd>{best ?? 'Not measured'}</dd></div><div><dt>Budget used</dt><dd>{duration(study.elapsedMs)} / {study.budgetMinutes} min · {experiments.length}/{study.maxExperiments} experiments</dd></div></dl>
    <div className="lab-section-title"><h3>Experiments</h3><span>{measured.length} measured</span></div>
    {!experiments.length ? <p className="lab-note">No experiments have run yet. Start the study to measure the untouched baseline first.</p> : <div className="lab-table-scroll"><table className="lab-table"><thead><tr><th>Experiment</th><th>State</th><th>{study.metric}</th><th>Evaluation</th><th>Decision</th><th /></tr></thead><tbody>{experiments.map(experiment => <tr key={experiment.id}><td>{experiment.kind === 'baseline' ? 'Baseline' : `Experiment ${experiment.ordinal}`}</td><td>{experiment.status}</td><td>{experiment.measurement?.value ?? '—'}</td><td>{experiment.measurement ? duration(experiment.measurement.durationMs) : '—'}</td><td>{experiment.decision === 'pending' ? 'Pending' : experiment.decision === 'keep' ? 'Kept' : 'Discarded'}</td><td>{experiment.taskId ? <button className="text-button" onClick={() => onOpenTask(experiment.taskId!)}>Open task <ArrowUpRight size={11} /></button> : null}</td></tr>)}</tbody></table></div>}
    {experiments.map(experiment => <ResearchExperimentEvidence key={experiment.id} studyId={study.id} experiment={experiment} running={running} onUpdated={onUpdated} />)}
    <details className="lab-evidence"><summary>Evaluation protocol</summary><pre>{JSON.stringify({ metric: study.metric, direction: study.direction, evaluator: study.evaluator, evaluatorFileHashes: study.evaluatorFileHashes, initialCommit: study.initialCommit, protocolHash: study.protocolHash }, null, 2)}</pre></details>
    <p className="lab-note">Metrics come from the host evaluator. A kept experiment is an improvement under this protocol; it does not establish broader quality or performance.</p>
  </article>
}

function ResearchExperimentEvidence({ studyId, experiment, running, onUpdated }: { studyId: string; experiment: ResearchExperiment; running: boolean; onUpdated: (detail: ResearchDetail) => void }) {
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const decide = async (decision: 'keep' | 'discard') => {
    if (busy || !reason.trim()) return
    setBusy(true); setError(null)
    try { onUpdated(await api<ResearchDetail>('research:decide', { studyId, experimentId: experiment.id, decision, reason: reason.trim() })) }
    catch (error) { setError(errorText(error)) }
    finally { setBusy(false) }
  }
  return <details className="lab-evidence"><summary>{experiment.kind === 'baseline' ? 'Baseline' : `Experiment ${experiment.ordinal}`} · hypothesis and evidence</summary>
    <p className="lab-note">{experiment.hypothesis}</p>{experiment.error ? <p className="lab-error">{experiment.error}</p> : null}{experiment.decisionReason ? <p className="lab-note">{experiment.decisionReason}</p> : null}
    {experiment.measurement ? <pre>{JSON.stringify(experiment.measurement, null, 2)}</pre> : <p className="lab-note">No evaluator measurement was recorded.</p>}
    {experiment.kind === 'candidate' && experiment.status === 'completed' && !running ? <div style={{ marginTop: 16 }}><div className="lab-field"><label htmlFor={`decision-${experiment.id}`}>Reason for changing the decision</label><textarea id={`decision-${experiment.id}`} rows={2} value={reason} onChange={event => setReason(event.target.value)} maxLength={4000} /></div>{error ? <p className="lab-error" role="alert">{error}</p> : null}<div className="lab-page-actions"><button className="secondary-button" disabled={busy || !reason.trim()} onClick={() => void decide('keep')}><Check size={13} />Keep</button><button className="secondary-button" disabled={busy || !reason.trim()} onClick={() => void decide('discard')}><X size={13} />Discard</button></div></div> : null}
  </details>
}
