import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { BenchmarkRecord, BenchmarkVariant } from './benchmark-types';
import { copyBenchmarkEvidence, validateEvidenceReceipt } from './benchmark-evidence';

const escape = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const amount = (value: number | null) => value === null ? 'Unavailable' : value.toLocaleString('en-US', { maximumFractionDigits: 6 });
const script = `
const videos=[...document.querySelectorAll('video[data-offset]')];
const seek=document.querySelector('#seek'),play=document.querySelector('#play'),status=document.querySelector('#playback-status');
let active=false,start=0,base=0;
const offset=v=>Number(v.dataset.offset||0)/1000;
const length=()=>Math.max(0,...videos.map(v=>Number.isFinite(v.duration)?v.duration+offset(v):0));
const align=t=>{for(const v of videos){const local=t-offset(v);if(local<0||!Number.isFinite(v.duration)||local>=v.duration){v.pause();if(Number.isFinite(v.duration))v.currentTime=Math.min(v.duration,Math.max(0,local));continue}if(Math.abs(v.currentTime-local)>.18)v.currentTime=local;if(active)v.play().catch(()=>{status.textContent='A recording could not play. Check the original file or browser format support.'});else v.pause()}};
for(const v of videos){v.addEventListener('loadedmetadata',()=>{seek.max=String(length());align(Number(seek.value))});v.addEventListener('error',()=>{status.textContent='One recording is unavailable or its format is unsupported.'})}
play?.addEventListener('click',()=>{active=!active;base=Number(seek.value);start=performance.now();play.textContent=active?'Pause recordings':'Play recordings';align(base)});
seek?.addEventListener('input',()=>{base=Number(seek.value);start=performance.now();align(base)});
function tick(){if(active){const t=Math.min(length(),base+(performance.now()-start)/1000);seek.value=String(t);align(t);if(t>=length()){active=false;play.textContent='Play recordings'}}requestAnimationFrame(tick)}tick();
`;
const css = `:root{color-scheme:light dark;font-family:system-ui,sans-serif;background:#fafafa;color:#252525}*{box-sizing:border-box}body{margin:0;padding:32px;max-width:1800px;margin-inline:auto}header{max-width:1000px}h1{font-size:28px;letter-spacing:-.6px}h2{font-size:18px}h3{font-size:14px}p,dl{font-size:14px;line-height:1.6}.muted{color:#696969}.comparison{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:16px;align-items:start}article{border:1px solid #ddd;border-radius:12px;padding:20px;background:white;min-width:0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.65 ui-monospace,monospace;background:#f4f4f4;padding:14px;border-radius:8px;max-height:65vh;overflow:auto}dt{font-size:12px;color:#777}dd{margin:0 0 8px;overflow-wrap:anywhere}video,img{display:block;width:100%;max-height:440px;object-fit:contain;background:#111;border-radius:8px}figure{margin:12px 0}figcaption{font-size:12px;margin-top:6px;overflow-wrap:anywhere}button{padding:9px 14px;border:1px solid #ccc;border-radius:7px;background:#fff;color:inherit;cursor:pointer}a{color:inherit}section.controls{position:sticky;top:0;background:#fafafaf2;padding:12px 0;z-index:1}input[type=range]{width:min(600px,80%)}.scope{border-left:3px solid #aaa;padding-left:12px}@media(prefers-color-scheme:dark){:root{background:#171717;color:#eee}article{background:#202020;border-color:#444}pre{background:#292929}.muted,dt{color:#aaa}button{background:#282828;border-color:#555}section.controls{background:#171717f2}}`;
function variantHtml(v: BenchmarkVariant) {
  const metrics = [['Status', v.status], ['Duration including runtime cleanup', v.durationMs === null ? 'Unavailable' : `${amount(v.durationMs / 1000)} s`], ['Input tokens', amount(v.usage.inputTokens)], ['Output tokens', amount(v.usage.outputTokens)], ['Total tokens', amount(v.usage.totalTokens)], ['Cost (USD, provider-reported)', v.usage.costUsd === null ? 'Unavailable' : `$${amount(v.usage.costUsd)}`]];
  const firstVideo = v.evidence.find(e => e.kind === 'video');
  return `<article><h2>${escape(v.label)}</h2><p>${escape(v.providerId)} · ${escape(v.model)} · ${escape(v.effort || 'default effort')}</p><div class="scope"><p>Method: ${escape(v.method.kind)}<br>Tool enforcement: ${escape(v.execution.toolScope)}<br>Workspace: ${escape(v.execution.workspaceIsolation)}</p><p class="muted">Requested tools: ${escape(v.method.allowedTools.join(', ') || 'No explicit whitelist')}<br>MCP: ${escape(v.method.mcpServerIds.join(', ') || 'None specified')}</p>${v.execution.notes.map(note => `<p>${escape(note)}</p>`).join('')}</div><dl>${metrics.map(([key,value]) => `<dt>${escape(key)}</dt><dd>${escape(value)}</dd>`).join('')}</dl><p class="muted">${v.usage.estimated === true ? 'Usage is marked estimated by the provider.' : 'Missing metrics remain unavailable; tokens and cost are not quality judgments.'}</p>${firstVideo ? '' : '<p class="muted">No recording supplied for this run.</p>'}${v.evidence.map(e => {
    const url = `evidence/${encodeURIComponent(e.filename)}`;
    const content = e.kind === 'video' ? `<video preload="metadata" ${e === firstVideo ? `data-offset="${e.videoStartOffsetMs ?? 0}"` : 'controls'} src="${url}" muted playsinline></video>` : e.kind === 'image' ? `<img src="${url}" alt="${escape(e.label)}">` : '';
    return `<figure>${content}<figcaption><a href="${url}" download>${escape(e.label)}</a> · ${escape(e.origin)} · ${amount(e.bytes)} bytes<br>SHA-256: ${escape(e.sha256)}${e.recordingNote ? `<br>${escape(e.recordingNote)}` : ''}${e.kind === 'video' ? `<br>${e.videoStartOffsetMs === null ? 'Run-relative capture offset unavailable; synchronization uses clip start.' : `Capture begins ${amount(e.videoStartOffsetMs / 1000)} s after run start.`}` : ''}</figcaption></figure>`;
  }).join('')}<h3>Recorded output</h3><pre>${escape(v.output || 'No output recorded.')}</pre><h3>Human review</h3><p>${escape(v.humanNotes || 'No human notes recorded.')}</p></article>`;
}
export function benchmarkComparisonHtml(record: BenchmarkRecord): string {
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const videos = record.variants.filter(v => v.evidence.some(e => e.kind === 'video')).length;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'sha256-${scriptHash}'; style-src 'unsafe-inline'; media-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-src 'none'"><title>${escape(record.title)} — Akorith comparison</title><style>${css}</style></head><body><header><h1>${escape(record.title)}</h1><p>Same prompt, different models or methods. Review quality yourself; this comparison does not calculate a winner.</p><pre>${escape(record.prompt)}</pre><p class="muted">Prompt SHA-256: ${escape(record.promptSha256)}<br>Exported results are a snapshot. <a href="manifest.json" download>Download manifest</a></p><p>${escape(record.humanNotes || 'No comparison notes recorded.')}</p></header>${videos ? `<section class="controls" aria-label="Synchronized recordings"><button id="play">Play recordings</button> <label>Timeline <input id="seek" type="range" min="0" max="0" step="0.01" value="0"></label><p id="playback-status" class="muted">${videos} recordings. Known capture offsets are respected; unknown offsets use clip-relative alignment. Playback is approximate, not frame-accurate measurement.</p></section>` : '<p class="muted">No video evidence supplied. None has been generated for this comparison.</p>'}<main class="comparison">${record.variants.map(variantHtml).join('')}</main><script>${script}</script></body></html>`;
}

/** Creates a new portable directory only. Does not publish, upload, or open a browser. */
export async function exportBenchmarkComparison(record: BenchmarkRecord, parentDirectory: string, evidenceDirectory: string) {
  const parent = await realpath(parentDirectory);
  const directory = join(parent, `akorith-benchmark-${record.id}-${randomUUID().slice(0, 8)}`);
  await mkdir(directory); await mkdir(join(directory, 'evidence'));
  const snapshot = structuredClone(record), seen = new Set<string>(); let total = 0;
  for (const variant of snapshot.variants) for (const evidence of variant.evidence) {
    validateEvidenceReceipt(evidence);
    if (seen.has(evidence.filename)) throw new Error('Duplicate evidence filename.');
    seen.add(evidence.filename); total += evidence.bytes;
    if (total > 4 * 1024 * 1024 * 1024) throw new Error('Comparison evidence exceeds the 4 GiB export limit.');
    const copied = await copyBenchmarkEvidence(join(evidenceDirectory, evidence.filename), join(directory, 'evidence', evidence.filename));
    if (copied.bytes !== evidence.bytes || copied.sha256 !== evidence.sha256) throw new Error('Evidence changed since capture; export is incomplete.');
  }
  const indexPath = join(directory, 'index.html'), manifestPath = join(directory, 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx' });
  await writeFile(indexPath, benchmarkComparisonHtml(snapshot), { flag: 'wx' });
  return { directory, indexPath, manifestPath };
}
