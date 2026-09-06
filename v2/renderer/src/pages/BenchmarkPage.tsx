import { ArrowLeft, ArrowUpRight, Columns2, Download, FilePlus2, Pause, Play, Plus, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AppSnapshot, PermissionMode } from '../../../shared/contracts'
import type { BenchmarkCreate, BenchmarkEvidence, BenchmarkMethod, BenchmarkRecord, BenchmarkSummary, BenchmarkVariant, BenchmarkVariantInput } from '../../../main/benchmark-types'
import { api, errorText, isActive } from '../api'
import { IconButton, Spinner } from '../components/Primitives'
import { Markdown } from '../components/Markdown'

export interface BenchmarkPageProps { snapshot: AppSnapshot; onError: (error: unknown) => void; onOpenTask: (taskId: string) => void }
const methodLabels: Record<BenchmarkMethod['kind'], string> = { default: 'Default tools', browser: 'Browser tools', computer: 'Computer tools', mcp: 'MCP tools', custom: 'Custom tool list' }
const time = (value: number | null) => value === null ? 'Not recorded' : value < 1000 ? `${Math.round(value)} ms` : `${(value / 1000).toFixed(1)} s`
export const benchmarkRunUnsupported = (variant: BenchmarkVariantInput) => variant.providerId !== 'ollama' && variant.method.kind !== 'default'

export function BenchmarkPage({ snapshot, onError, onOpenTask }: BenchmarkPageProps) {
  const [benchmarks, setBenchmarks] = useState<BenchmarkSummary[]>([]), [selected, setSelected] = useState<string | null>(null), [record, setRecord] = useState<BenchmarkRecord | null>(null)
  const [creating, setCreating] = useState(false), [loading, setLoading] = useState(true), [error, setError] = useState<string | null>(null), [busy, setBusy] = useState<string | null>(null), [limit, setLimit] = useState(40)
  const selectedRef = useRef(selected), mounted = useRef(true), generation = useRef(0)
  selectedRef.current = selected
  const refresh = useCallback(async () => {
    const current = ++generation.current
    try {
      const list = await api<BenchmarkSummary[]>('benchmark:list')
      const id = selectedRef.current && list.some(item => item.id === selectedRef.current) ? selectedRef.current : list[0]?.id || null
      const detail = id ? await api<BenchmarkRecord>('benchmark:read', { benchmarkId: id }) : null
      if (!mounted.current || current !== generation.current) return
      setBenchmarks(list); setSelected(id); setRecord(detail); setError(null)
    } catch (error) { if (mounted.current && current === generation.current) setError(errorText(error)) }
    finally { if (mounted.current && current === generation.current) setLoading(false) }
  }, [])
  useEffect(() => {
    mounted.current = true; void refresh()
    let timer: ReturnType<typeof setTimeout> | undefined
    const off = window.akorith?.onEvent(event => { if (event.type === 'changed' && timer === undefined) { timer = setTimeout(() => { timer = undefined; void refresh() }, 180) } })
    return () => { mounted.current = false; generation.current++; clearTimeout(timer); off?.() }
  }, [refresh])
  const select = async (id: string) => {
    selectedRef.current = id; setSelected(id); setRecord(null); setCreating(false); setError(null)
    const current = ++generation.current
    try { const next = await api<BenchmarkRecord>('benchmark:read', { benchmarkId: id }); if (mounted.current && current === generation.current) setRecord(next) }
    catch (error) { if (mounted.current && current === generation.current) setError(errorText(error)) }
  }
  const action = async (command: 'benchmark:start' | 'benchmark:stop', benchmarkId: string) => {
    if (busy === command) return
    setBusy(command); setError(null)
    try { await api(command, { benchmarkId }); await refresh() }
    catch (error) { if (mounted.current) setError(errorText(error)); else onError(error) }
    finally { if (mounted.current) setBusy(null) }
  }
  return <section className="lab-page" aria-label="Benchmarks"><div className="lab-page-inner">
    <header className="lab-page-header"><div className="lab-page-heading"><h1>Benchmarks</h1><p>Compare models and methods on the same prompt. Inspect the work and decide what matters.</p></div><div className="lab-page-actions"><IconButton label="Refresh benchmarks" onClick={() => void refresh()}><RefreshCw size={15} /></IconButton><button className="primary-button" onClick={() => setCreating(true)}><Plus size={14} />New comparison</button></div></header>
    {error ? <p className="lab-error" role="alert">{error}</p> : null}
    {creating ? <BenchmarkForm snapshot={snapshot} onCancel={() => setCreating(false)} onCreated={async next => { selectedRef.current = next.id; setSelected(next.id); setCreating(false); await refresh() }} /> : loading ? <div className="lab-inline-state" role="status"><Spinner size={15} />Loading comparisons…</div> : !benchmarks.length ? <div className="lab-empty"><Columns2 size={36} strokeWidth={1.2} /><h2>See the difference for yourself</h2><p>Run a shared prompt through two or more variants. Compare their output, recordings, time, tokens, and reported cost side by side.</p><button className="secondary-button" onClick={() => setCreating(true)}><Plus size={14} />Create a comparison</button></div> : <div className="lab-layout">
      <nav className="lab-run-nav" aria-label="Benchmark comparisons"><div className="lab-run-nav-title"><span>Comparisons</span><span>{benchmarks.length}</span></div>{benchmarks.slice(0, limit).map(item => <button key={item.id} className={`lab-run-item ${item.id === selected ? 'selected' : ''}`} aria-current={item.id === selected ? 'page' : undefined} onClick={() => void select(item.id)}><strong>{item.title}</strong><span className="lab-run-item-meta"><span>{item.runningCount ? `${item.runningCount} running` : `${item.terminalCount}/${item.variantCount} finished`}</span><time>{new Date(item.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</time></span></button>)}{benchmarks.length > limit ? <button className="text-button" onClick={() => setLimit(value => value + 40)}>Show more comparisons</button> : null}</nav>
      {record?.id === selected ? <BenchmarkComparison key={record.id} record={record} busy={busy} onStart={() => void action('benchmark:start', record.id)} onStop={() => void action('benchmark:stop', record.id)} onOpenTask={onOpenTask} onUpdated={() => { void refresh() }} onError={onError} /> : <div className="lab-inline-state" role="status"><Spinner size={15} />Opening comparison…</div>}
    </div>}
  </div></section>
}

interface VariantDraft { key: string; label: string; choice: string; effort: string; mode: PermissionMode; kind: BenchmarkMethod['kind']; allowedTools: string; mcpServerIds: string; notes: string }
export function benchmarkMethodInput(kind: BenchmarkMethod['kind'], customTools: string, mcpServerIds: string, notes: string): BenchmarkMethod {
  const presets = {
    browser: ['browser_list', 'browser_open', 'browser_navigate', 'browser_snapshot', 'browser_click', 'browser_type', 'browser_key', 'browser_scroll', 'browser_screenshot'],
    computer: ['computer_state', 'computer_select', 'computer_snapshot', 'computer_capture', 'computer_click', 'computer_type', 'computer_key', 'computer_stop'],
  }
  return { kind, allowedTools: kind === 'browser' || kind === 'computer' ? presets[kind] : kind === 'custom' ? customTools.split('\n').map(value => value.trim()).filter(Boolean) : [], mcpServerIds: kind === 'mcp' ? mcpServerIds.split('\n').map(value => value.trim()).filter(Boolean) : [], notes: notes.trim() }
}
export function benchmarkMethodSelection(kind: BenchmarkMethod['kind']): Pick<VariantDraft, 'kind'> & Partial<Pick<VariantDraft, 'mode'>> {
  return kind === 'computer' ? { kind, mode: 'full' } : { kind }
}
const draftVariant = (index: number): VariantDraft => ({ key: `variant-${index}`, label: `Variant ${index}`, choice: '', effort: '', mode: 'work', kind: 'default', allowedTools: '', mcpServerIds: '', notes: '' })
export function benchmarkInitialVariants(snapshot: AppSnapshot): VariantDraft[] {
  const seen = new Set<string>()
  const models = snapshot.providers.filter(provider => provider.available && provider.authenticated !== false).flatMap(provider => provider.models.map(model => ({ provider, model, key: `${provider.id}:${model.id}` }))).filter(item => { if (seen.has(item.key)) return false; seen.add(item.key); return true })
  return [0, 1].map(index => {
    const draft = draftVariant(index + 1), selected = models[index]
    return selected ? { ...draft, choice: selected.key, label: `${selected.model.name} · ${selected.provider.name}`.slice(0, 100), effort: selected.model.efforts?.[0] || '' } : draft
  })
}
function BenchmarkForm({ snapshot, onCancel, onCreated }: { snapshot: AppSnapshot; onCancel: () => void; onCreated: (record: BenchmarkRecord) => Promise<void> }) {
  const [title, setTitle] = useState(''), [prompt, setPrompt] = useState(''), [projectId, setProjectId] = useState('')
  const [variants, setVariants] = useState<VariantDraft[]>(() => benchmarkInitialVariants(snapshot)), nextId = useRef(3)
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null)
  const models = snapshot.providers.flatMap(provider => provider.models.map(model => ({ provider, model, key: `${provider.id}:${model.id}` })))
  const patch = (key: string, value: Partial<VariantDraft>) => setVariants(current => current.map(variant => variant.key === key ? { ...variant, ...value } : variant))
  const ready = variants.every(variant => { const selected = models.find(item => item.key === variant.choice); return selected?.provider.available && selected.provider.authenticated !== false && (selected.provider.id === 'ollama' || variant.kind === 'default') })
  return <form className="lab-form" onSubmit={event => {
    event.preventDefault()
    if (!ready || busy) return
    const input: BenchmarkCreate = { title: title.trim(), prompt: prompt.trim(), projectId: projectId || null, variants: variants.map(variant => { const selected = models.find(item => item.key === variant.choice)!; return { label: variant.label.trim(), providerId: selected.provider.id, model: selected.model.id, effort: variant.effort, mode: variant.mode, method: benchmarkMethodInput(variant.kind, variant.allowedTools, variant.mcpServerIds, variant.notes) } }) }
    setBusy(true); setError(null)
    void api<BenchmarkRecord>('benchmark:create', input).then(onCreated).catch(error => setError(errorText(error))).finally(() => setBusy(false))
  }}>
    <div className="lab-form-header"><button type="button" className="text-button" onClick={onCancel}><ArrowLeft size={13} />All comparisons</button><h2>New benchmark</h2><p>Use a shared prompt and project fixture. Change the model, tool method, or permissions explicitly for each variant.</p></div>
    {error ? <p className="lab-error" role="alert">{error}</p> : null}
    <fieldset disabled={busy} style={{ border: 0, padding: 0, margin: 0 }}><div className="lab-field"><label htmlFor="benchmark-title">Comparison name</label><input id="benchmark-title" value={title} onChange={event => setTitle(event.target.value)} maxLength={160} required placeholder="Implement the ticket dashboard" /></div>
      <div className="lab-field"><label htmlFor="benchmark-prompt">Shared prompt</label><textarea id="benchmark-prompt" value={prompt} onChange={event => setPrompt(event.target.value)} rows={5} required maxLength={64000} placeholder="Describe the same task that every variant will receive." /></div>
      <div className="lab-field"><label htmlFor="benchmark-project">Project fixture</label><select id="benchmark-project" value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">New workspace for each variant</option>{snapshot.projects.map(project => <option key={project.id} value={project.id}>{project.name}</option>)}</select><small>The execution record will show the actual isolation and fixture fingerprint used.</small></div>
      {variants.map((variant, index) => { const selected = models.find(item => item.key === variant.choice); return <section className="lab-variant-editor" key={variant.key}><div className="lab-variant-editor-header"><h3>Variant {index + 1}</h3><IconButton label={`Remove variant ${index + 1}`} disabled={variants.length <= 2} onClick={() => setVariants(current => current.filter(item => item.key !== variant.key))}><Trash2 size={13} /></IconButton></div>
        <div className="lab-fields-row"><div className="lab-field"><label htmlFor={`${variant.key}-label`}>Label</label><input id={`${variant.key}-label`} value={variant.label} required maxLength={100} onChange={event => patch(variant.key, { label: event.target.value })} /></div><div className="lab-field"><label htmlFor={`${variant.key}-model`}>Model and connection</label><select id={`${variant.key}-model`} value={variant.choice} required onChange={event => { const model = models.find(item => item.key === event.target.value)?.model; patch(variant.key, { choice: event.target.value, effort: model?.efforts?.includes(variant.effort) ? variant.effort : model?.efforts?.[0] || '' }) }}><option value="">Choose a model</option>{snapshot.providers.map(provider => <optgroup key={provider.id} label={`${provider.name} · ${provider.connectionLabel}`} disabled={!provider.available || provider.authenticated === false}>{provider.models.map(model => <option key={model.id} value={`${provider.id}:${model.id}`}>{model.name}</option>)}</optgroup>)}</select></div></div>
        <div className="lab-fields-row"><div className="lab-field"><label htmlFor={`${variant.key}-method`}>Tool method</label><select id={`${variant.key}-method`} value={variant.kind} onChange={event => patch(variant.key, benchmarkMethodSelection(event.target.value as BenchmarkMethod['kind']))}>{Object.entries(methodLabels).map(([kind, label]) => <option key={kind} value={kind} disabled={kind !== 'default' && selected?.provider.id !== 'ollama'}>{label}</option>)}</select><small>{selected?.provider.id === 'ollama' ? 'Local runs can enforce the selected host tool scope.' : 'Native connections currently support their default tool scope only.'}</small></div><div className="lab-field"><label htmlFor={`${variant.key}-mode`}>Permissions</label><select id={`${variant.key}-mode`} disabled={variant.kind === 'computer'} value={variant.mode} onChange={event => patch(variant.key, { mode: event.target.value as PermissionMode })}><option value="read">Read only</option><option value="work">Workspace access</option><option value="full">Full access</option></select>{variant.kind === 'computer' ? <small>Computer tools require Full access to the explicitly selected application. Selecting this method sets that permission.</small> : null}</div></div>
        {selected?.model.efforts?.length ? <div className="lab-field"><label htmlFor={`${variant.key}-effort`}>Reasoning effort</label><select id={`${variant.key}-effort`} value={variant.effort} onChange={event => patch(variant.key, { effort: event.target.value })}>{selected.model.efforts.map(effort => <option key={effort} value={effort}>{effort}</option>)}</select></div> : null}
        {variant.kind === 'custom' ? <div className="lab-field"><label htmlFor={`${variant.key}-tools`}>Allowed tool names</label><textarea id={`${variant.key}-tools`} value={variant.allowedTools} onChange={event => patch(variant.key, { allowedTools: event.target.value })} placeholder={'files_read\nfiles_write'} /><small>One exact tool name per line. Availability is validated before execution.</small></div> : null}
        {variant.kind === 'mcp' ? <div className="lab-field"><label htmlFor={`${variant.key}-mcp`}>MCP server IDs</label><textarea id={`${variant.key}-mcp`} value={variant.mcpServerIds} onChange={event => patch(variant.key, { mcpServerIds: event.target.value })} /><small>One configured server ID per line.</small></div> : null}
        <div className="lab-field"><label htmlFor={`${variant.key}-notes`}>Method notes</label><textarea id={`${variant.key}-notes`} value={variant.notes} onChange={event => patch(variant.key, { notes: event.target.value })} rows={2} placeholder="Record what you expect this variant to do differently." /><small>Notes describe the setup; they are not evidence that a restriction was enforced.</small></div>
      </section> })}
      <button type="button" className="secondary-button" disabled={variants.length >= 8} onClick={() => setVariants(current => [...current, draftVariant(nextId.current++)])}><Plus size={13} />Add variant</button>
    </fieldset><div className="lab-form-actions"><button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>Cancel</button><button className="primary-button" disabled={busy || !ready}>{busy ? <Spinner size={13} /> : <Plus size={13} />}Create comparison</button></div>
  </form>
}

export function BenchmarkComparison({ record, busy, onStart, onStop, onOpenTask, onUpdated, onError }: { record: BenchmarkRecord; busy: string | null; onStart: () => void; onStop: () => void; onOpenTask: (taskId: string) => void; onUpdated: (record: BenchmarkRecord) => void; onError: (error: unknown) => void }) {
  const [left, setLeft] = useState(record.variants[0]?.id || ''), [right, setRight] = useState(record.variants[1]?.id || '')
  const [notes, setNotes] = useState(record.humanNotes), [saving, setSaving] = useState(false), [exporting, setExporting] = useState(false), [exported, setExported] = useState<string | null>(null)
  const videos = useRef(new Map<string, HTMLVideoElement>())
  const running = record.variants.some(variant => isActive(variant.status === 'not-started' ? undefined : variant.status))
  const unsupported = record.variants.some(benchmarkRunUnsupported)
  const choices = [record.variants.find(variant => variant.id === left), record.variants.find(variant => variant.id === right)]
  const saveNotes = async () => { setSaving(true); try { onUpdated(await api<BenchmarkRecord>('benchmark:annotate', { benchmarkId: record.id, notes })) } catch (error) { onError(error) } finally { setSaving(false) } }
  const exportResults = async () => { setExporting(true); try { const result = await api<{ directory: string } | null>('benchmark:export', { benchmarkId: record.id }); if (result) setExported(result.directory) } catch (error) { onError(error) } finally { setExporting(false) } }
  return <article className="lab-detail"><header className="lab-detail-header"><div><h2>{record.title}</h2><p>{record.variants.length} variants · one shared prompt</p></div><div className="lab-page-actions"><IconButton label="Export comparison" disabled={exporting} onClick={() => void exportResults()}>{exporting ? <Spinner size={14} /> : <Download size={15} />}</IconButton>{running ? <button className="secondary-button" disabled={busy === 'benchmark:stop'} onClick={onStop}><Square size={12} />Stop</button> : <button className="primary-button" disabled={!!busy || unsupported || record.variants.every(variant => variant.status !== 'not-started')} onClick={onStart}><Play size={13} />Run comparison</button>}</div></header>
    {unsupported ? <p className="lab-error">A native connection cannot enforce this comparison’s restricted tool method. Create a comparison using Default tools for native connections, or a local model for restricted methods.</p> : null}
    {exported ? <p className="lab-note" role="status">Exported to {exported}</p> : null}
    <details className="lab-evidence"><summary>Shared prompt and fingerprint</summary><pre>{record.prompt}</pre><p className="lab-note">SHA-256: {record.promptSha256}</p></details>
    <div className="lab-section-title"><h3>Compare outputs</h3><span>Human review</span></div>
    <div className="lab-comparison-controls"><select aria-label="Left comparison variant" value={left} onChange={event => setLeft(event.target.value)}>{record.variants.map(variant => <option key={variant.id} value={variant.id} disabled={variant.id === right}>{variant.label}</option>)}</select><select aria-label="Right comparison variant" value={right} onChange={event => setRight(event.target.value)}>{record.variants.map(variant => <option key={variant.id} value={variant.id} disabled={variant.id === left}>{variant.label}</option>)}</select></div>
    <div className="lab-page-actions"><button className="secondary-button" onClick={() => { const active = [...videos.current.values()]; if (active.length < 2) { onError(new Error('Load a video preview in both columns first.')); return } for (const video of active) video.currentTime = 0; void Promise.all(active.map(video => video.play())).catch(onError) }}><Play size={12} />Play both from beginning</button><button className="text-button" onClick={() => { for (const video of videos.current.values()) video.pause() }}><Pause size={12} />Pause both</button></div>
    <p className="lab-note">Playback starts both recordings at their beginning. A recording without a captured start offset is not aligned to the run’s timeline.</p>
    <div className="lab-comparison">{choices.map((variant, index) => variant ? <BenchmarkVariantColumn key={`${index}:${variant.id}`} benchmarkId={record.id} variant={variant} onOpenTask={onOpenTask} onUpdated={onUpdated} onError={onError} onVideo={element => { const key = String(index); if (element) videos.current.set(key, element); else videos.current.delete(key) }} /> : null)}</div>
    <div className="lab-section-title"><h3>Your assessment</h3></div><div className="lab-field"><label htmlFor={`benchmark-notes-${record.id}`}>What worked better, and why?</label><textarea id={`benchmark-notes-${record.id}`} value={notes} onChange={event => setNotes(event.target.value)} rows={4} maxLength={16000} placeholder="Compare correctness, usability, and the evidence that supports your preference." /></div><button className="secondary-button" disabled={saving || notes === record.humanNotes} onClick={() => void saveNotes()}>{saving ? <Spinner size={12} /> : null}Save assessment</button>
    <p className="lab-note">Missing measurements remain unrecorded. Time, token use, and reported cost do not determine a quality winner.</p>
  </article>
}

export function benchmarkTokenLabel(usage: BenchmarkVariant['usage']): string {
  const suffix = usage.estimated ? ' est.' : ''
  if (usage.totalTokens !== null) return `${usage.totalTokens.toLocaleString()}${suffix}`
  if (usage.inputTokens === null && usage.outputTokens === null) return 'Not recorded'
  return `${usage.inputTokens === null ? 'Unknown' : usage.inputTokens.toLocaleString()} input · ${usage.outputTokens === null ? 'unknown' : usage.outputTokens.toLocaleString()} output${suffix}`
}

function BenchmarkVariantColumn({ benchmarkId, variant, onOpenTask, onUpdated, onError, onVideo }: { benchmarkId: string; variant: BenchmarkVariant; onOpenTask: (id: string) => void; onUpdated: (record: BenchmarkRecord) => void; onError: (error: unknown) => void; onVideo: (element: HTMLVideoElement | null) => void }) {
  const [adding, setAdding] = useState(false), [outputLimit, setOutputLimit] = useState(12000), [evidenceLimit, setEvidenceLimit] = useState(12)
  const addEvidence = async () => { setAdding(true); try { const record = await api<BenchmarkRecord | null>('benchmark:addEvidence', { benchmarkId, variantId: variant.id }); if (record) onUpdated(record) } catch (error) { onError(error) } finally { setAdding(false) } }
  return <section className="lab-comparison-column" aria-label={variant.label}><h3>{variant.label}</h3><div className="lab-comparison-model">{variant.providerId} · {variant.model}<br />{methodLabels[variant.method.kind]} · {variant.mode} access · {variant.status}</div>
    {variant.taskId ? <button className="text-button" onClick={() => onOpenTask(variant.taskId!)}>Open task <ArrowUpRight size={11} /></button> : null}
    <dl className="lab-measurements"><div><dt>Run time</dt><dd>{time(variant.durationMs)}</dd></div><div><dt>Tokens</dt><dd>{benchmarkTokenLabel(variant.usage)}</dd></div><div><dt>Reported cost</dt><dd>{variant.usage.costUsd === null ? 'Not recorded' : `$${variant.usage.costUsd.toFixed(4)}`}</dd></div></dl>
    <div className="lab-section-title"><h3>Artifacts</h3><IconButton label={`Add evidence to ${variant.label}`} disabled={adding} onClick={() => void addEvidence()}>{adding ? <Spinner size={13} /> : <FilePlus2 size={14} />}</IconButton></div>
    {!variant.evidence.length ? <p className="lab-note">No artifact or recording has been attached.</p> : variant.evidence.slice(0, evidenceLimit).map(evidence => <BenchmarkEvidencePreview key={evidence.id} benchmarkId={benchmarkId} variantId={variant.id} evidence={evidence} onVideo={evidence.id === variant.evidence.find(item => item.kind === 'video')?.id ? onVideo : undefined} />)}{variant.evidence.length > evidenceLimit ? <button className="text-button" onClick={() => setEvidenceLimit(value => value + 12)}>Show more artifacts</button> : null}
    <div className="lab-section-title"><h3>Output</h3></div>{variant.output ? <div className="lab-comparison-output" style={{ whiteSpace: 'normal' }}><Markdown text={variant.output.slice(0, outputLimit)} onError={onError} onOpenFile={() => { if (variant.taskId) onOpenTask(variant.taskId); else onError(new Error('This recorded output has no originating task to inspect its files.')) }} /></div> : <p className="lab-note">{variant.status === 'not-started' ? 'This variant has not run yet.' : 'No response text has been recorded.'}</p>}{variant.output.length > outputLimit ? <button className="text-button" onClick={() => setOutputLimit(value => value + 12000)}>Show more output</button> : null}
    <details className="lab-evidence"><summary>Execution evidence</summary><pre>{JSON.stringify({ timingSource: variant.timingSource, execution: variant.execution, method: variant.method, usage: variant.usage }, null, 2)}</pre></details>
    {variant.humanNotes ? <p className="lab-note">Reviewer notes: {variant.humanNotes}</p> : null}
  </section>
}

function BenchmarkEvidencePreview({ benchmarkId, variantId, evidence, onVideo }: { benchmarkId: string; variantId: string; evidence: BenchmarkEvidence; onVideo?: (element: HTMLVideoElement | null) => void }) {
  const [media, setMedia] = useState<{ mimeType: string; dataUrl: string } | null>(null), [busy, setBusy] = useState(false), [unavailable, setUnavailable] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const preview = async () => {
    if (busy) return
    setBusy(true); setUnavailable(null)
    try {
      const result = await api<{ mimeType: string; dataUrl: string } | { unavailable: string }>('benchmark:media', { benchmarkId, variantId, evidenceId: evidence.id })
      if (!mounted.current) return
      if ('unavailable' in result) setUnavailable(result.unavailable)
      else if (!/^(image\/(png|jpeg|webp|gif)|video\/(mp4|webm|quicktime))$/.test(result.mimeType) || !result.dataUrl.startsWith(`data:${result.mimeType};base64,`)) setUnavailable('This artifact has no supported inline preview. Export the comparison to inspect the original file.')
      else setMedia(result)
    } catch (error) { if (mounted.current) setUnavailable(errorText(error)) }
    finally { if (mounted.current) setBusy(false) }
  }
  return <div className="lab-artifact"><p>{evidence.label} · {evidence.kind}</p>{media ? media.mimeType.startsWith('video/') ? <video ref={onVideo} src={media.dataUrl} controls preload="metadata" onError={() => { setMedia(null); setUnavailable('This recording cannot be played inline. Export the comparison to open the original video.') }} /> : <img src={media.dataUrl} alt={evidence.label} onError={() => { setMedia(null); setUnavailable('This image could not be decoded. The original remains available in the export.') }} /> : <button className="text-button" disabled={busy || evidence.kind === 'artifact'} onClick={() => void preview()}>{busy ? <Spinner size={12} /> : <Play size={12} />}Preview {evidence.kind}</button>}
    {unavailable ? <p role="status">{unavailable}</p> : null}{evidence.recordingNote ? <p className="lab-note">{evidence.recordingNote}</p> : null}<p className="lab-note">{evidence.origin === 'engine-capture' ? 'Captured during execution' : 'Added by a reviewer'} · {(evidence.bytes / 1024).toFixed(1)} KB{evidence.kind === 'video' ? evidence.videoStartOffsetMs === null ? ' · run offset not recorded' : ` · capture began ${time(evidence.videoStartOffsetMs)} after run start` : ''}</p><details className="lab-evidence"><summary>Artifact fingerprint</summary><pre>{evidence.filename}{'\n'}SHA-256: {evidence.sha256}</pre></details>
  </div>
}
