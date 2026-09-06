#!/usr/bin/env node
/** Explicit live acceptance against one named package and a new disposable fixture. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');

const option = (name, fallback) => { const at = process.argv.indexOf(name); return at < 0 ? fallback : process.argv[at + 1]; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error?.stack || String(error);
const terminal = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const PROTOCOL = 'packaged-connected-workflows-v1';
function freeMimo(catalog, requested) {
  const allowed = catalog.filter(model => /^opencode\/[^/]*mimo[^/]*-free$/i.test(model.id));
  const selected = requested ? allowed.find(model => model.id === requested) : allowed.sort((a, b) => a.id.localeCompare(b.id))[0];
  if (!selected) throw new Error('No explicitly free MiMo model on the opencode/ route is present in the actual connected catalog. No paid/OpenCode Go fallback is allowed.');
  return selected;
}
function knownReadApproval(request, { taskId, turnId, stage, project }) {
  if (stage !== 'opencode-read' || request.taskId !== taskId || request.turnId !== turnId || request.kind !== 'approval') return false;
  if (!/^Allow (?:mcp__)?akorith(?:__|[_.:-])files_read\?$/i.test(request.title)) return false;
  if (!request.choices?.includes('Allow once')) return false;
  // OpenCode's tool permission may use '*' as its pattern. The exact tool is a
  // per-run task-scoped Akorith bridge, with no attachments or enabled skills.
  const patterns = String(request.detail || '').split('\n').map(value => value.trim()).filter(Boolean);
  return patterns.every(value => ['*', 'handoff.md', './handoff.md', path.join(project, 'handoff.md')].includes(value));
}
async function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function identify(executable, port) {
  const matches = cp.execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 3000 }).split('\n').filter(line => line.includes(executable) && line.includes(`--remote-debugging-port=${port}`));
  assert.equal(matches.length, 1, 'Exactly one launched main process must match the exact app and random CDP port.');
  const pid = Number(matches[0].trim().split(/\s+/)[0]);
  const identity = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8', timeout: 3000 }).trim();
  return { pid, identity };
}
function probe(pid) {
  try { process.kill(pid, 0); return { state: 'alive' }; }
  catch (error) { return error.code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', code: error.code, message: error.message }; }
}
async function cleanupOwned(owner) {
  const start = performance.now(), result = { pid: owner.pid, method: 'SIGTERM', normalQuitTest: false, confirmedAbsent: false, forced: false, signals: [], probes: [], errors: [] };
  const observe = () => {
    const value = probe(owner.pid), prior = result.probes.at(-1);
    if (!prior || prior.state !== value.state || prior.code !== value.code) result.probes.push({ ...value, elapsedMs: performance.now() - start });
    if (value.state === 'absent') result.confirmedAbsent = true;
    return value;
  };
  const signal = name => {
    if (observe().state === 'absent') return;
    let current;
    try { current = cp.execFileSync('/bin/ps', ['-p', String(owner.pid), '-o', 'lstart=,command='], { encoding: 'utf8', timeout: 3000 }).trim(); }
    catch (error) { if (observe().state === 'absent') return; throw error; }
    assert.equal(current, owner.identity, 'Refusing to signal a reused or unidentified PID.');
    try { process.kill(owner.pid, name); result.signals.push({ signal: name, delivered: true, elapsedMs: performance.now() - start }); }
    catch (error) { result.signals.push({ signal: name, delivered: false, code: error.code }); if (error.code === 'ESRCH') result.confirmedAbsent = true; else result.errors.push(errorText(error)); }
  };
  const wait = async ms => { const end = performance.now() + ms; while (!result.confirmedAbsent && performance.now() < end) { observe(); if (!result.confirmedAbsent) await delay(100); } observe(); };
  try { signal('SIGTERM'); await wait(30000); if (!result.confirmedAbsent) { result.forced = true; signal('SIGKILL'); await wait(5000); } }
  catch (error) { result.errors.push(errorText(error)); observe(); }
  return { ...result, successful: result.confirmedAbsent && !result.forced && !result.errors.length, elapsedMs: performance.now() - start, scope: 'Exact owned main PID only; separate native-Quit and descendant-quiescence evidence is required.' };
}
async function until(check, label, timeout = 15000) {
  const end = performance.now() + timeout;
  while (performance.now() < end) { const value = await check(); if (value) return value; await delay(250); }
  throw new Error(`Timed out: ${label}`);
}
async function bounded(operation, label, timeout = 30000) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout); })]); }
  finally { clearTimeout(timer); }
}
function hasTool(message, tool) { return message.activities.some(activity => activity.kind === 'tool' && activity.status === 'completed' && new RegExp(`(?:^|[^a-z])${tool}(?:$|[^a-z])`, 'i').test(activity.title)); }
function noTools(message) { return !message.activities.some(activity => ['tool', 'command', 'file'].includes(activity.kind)); }

async function main() {
  if (!process.argv.includes('--run')) {
    console.log('Live connected-provider acceptance; uses existing Codex subscription, local Ollama and explicitly free OpenCode MiMo only.\nUsage: node packaged-connected-workflows.cjs --run --app "/exact/Akorith Next.app" --expected-version 2.0.0-alpha.3 [--package-id B03] [--with-browser] [--output /tmp/report-dir]\nCreates fresh disposable data/project. No GUI or models run without --run. See PACKAGED_CONNECTED_WORKFLOWS.md.');
    return;
  }
  assert.equal(process.platform, 'darwin', 'This harness targets the macOS LaunchServices package.');
  const appArgument = option('--app'); assert.ok(appArgument, 'An exact --app is required.');
  const app = fs.realpathSync(path.resolve(appArgument)), executable = path.join(app, 'Contents', 'MacOS', 'Akorith Next');
  assert.ok(app.endsWith('.app') && fs.existsSync(executable), 'The exact app must contain the Akorith Next executable.');
  const expectedVersion = option('--expected-version'); assert.ok(expectedVersion, '--expected-version is required; an old package must not be mistaken for the new build.');
  const timeout = Number(option('--turn-timeout-ms', '120000')); assert.ok(Number.isFinite(timeout) && timeout >= 1000 && timeout <= 240000, '--turn-timeout-ms must be 1000..240000.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'akorith-connected-workflows-')), data = path.join(root, 'data'), project = path.join(root, 'project');
  fs.mkdirSync(data); fs.mkdirSync(project);
  const output = path.resolve(option('--output', root)); fs.mkdirSync(output, { recursive: true });
  assert.ok(!fs.existsSync(path.join(output, 'connected-workflows.json')), 'Refusing to overwrite an earlier connected workflow report.');
  const originalReference = `ILK-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, laterReference = `SON-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, formReference = `FORM-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
  fs.writeFileSync(path.join(project, 'source.txt'), `Başlangıç — İstanbul\nReference: ${originalReference}\n`);
  fs.writeFileSync(path.join(project, 'index.html'), `<!doctype html><html lang="tr"><meta charset="utf-8"><title>Akorith synthetic form</title><body><main><h1>Local synthetic form</h1><form id="fixture-form"><label>Fixture name<input name="fixture-name" required autocomplete="off"></label><button type="submit">Confirm local fixture</button></form><output id="fixture-result" aria-live="polite"></output></main><script>document.querySelector('form').addEventListener('submit',event=>{event.preventDefault();document.querySelector('output').textContent=document.querySelector('input').value+' · '+${JSON.stringify(formReference)};document.body.dataset.confirmed='true'})</script></body></html>`);
  const report = { protocol: PROTOCOL, harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), packageId: option('--package-id', 'B03'), app, expectedVersion, root, data, project, syntheticUserData: true, actualModelRuns: true, realModelRuns: 0, expectedTurns: process.argv.includes('--with-browser') ? 6 : 5, turnTimeoutMs: timeout, references: { originalReference, laterReference, formReference }, startedAt: new Date().toISOString(), turns: [], checks: [], errors: [], approvals: [], diagnostics: [], stages: [], completed: false, successful: false, limits: ['Existing connections only; no login, credential reads or OS permission changes.', 'OpenCode route must be catalog-listed opencode/*mimo*-free; no paid or OpenCode Go fallback.', 'Task/project creation uses public IPC; provider/model/mode selection, Send and approval are real UI actions.', 'SIGTERM cleanup is not native Quit certification. No aggregate pass unless every required assertion and cleanup passes.'] };
  const save = () => fs.writeFileSync(path.join(output, 'connected-workflows.json'), JSON.stringify(report, null, 2) + '\n');
  const record = (name, value) => { report.checks.push({ name, at: new Date().toISOString(), ...value }); console.log(JSON.stringify({ check: name, ...value })); save(); };
  let browser, page, owner, port, launchAttempted = false, taskId;
  const start = performance.now();
  const invoke = (command, payload = {}) => bounded(page.evaluate(({ command, payload }) => window.akorith.invoke(command, payload), { command, payload }), `IPC ${command}`);
  const diagnostics = async label => { const value = await invoke('app:diagnostics'); report.diagnostics.push({ label, at: new Date().toISOString(), value }); return value; };
  const stopTask = async reason => {
    const attempt = { reason, taskId, at: new Date().toISOString() }; report.stopAttempt = attempt;
    if (!taskId || !page) return;
    try { const button = page.getByRole('button', { name: 'Stop task', exact: true }); if (await button.count() && await button.isEnabled()) { await button.click(); attempt.via = 'UI Stop task'; } else { await invoke('task:stop', { taskId }); attempt.via = 'IPC stop fallback; not UI success'; } }
    catch (error) { attempt.error = errorText(error); }
  };
  const unexpectedPending = async (pending, reason) => {
    report.approvals.push({ request: pending, decision: 'unexpected: stop', reason, at: new Date().toISOString() }); save();
    try { const card = page.locator('.pending-card').filter({ has: page.getByRole('heading', { name: pending.title, exact: true }) }); if (await card.count() === 1 && pending.choices?.includes('Deny')) { await card.getByRole('button', { name: 'Deny', exact: true }).click(); report.approvals.at(-1).deniedViaUi = true; } } catch (error) { report.approvals.at(-1).denyError = errorText(error); }
    await stopTask(reason);
    throw new Error(reason);
  };
  const choose = async (providerId, modelId, mode) => {
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption(providerId);
    await until(async () => (await invoke('task:read', { taskId })).task.providerId === providerId, `provider UI selection ${providerId}`);
    await page.getByRole('combobox', { name: 'Model', exact: true }).selectOption(modelId);
    await page.getByRole('combobox', { name: 'Permission mode', exact: true }).selectOption(mode);
    const effort = page.getByRole('combobox', { name: 'Reasoning effort', exact: true });
    if (await effort.count() && await effort.locator('option[value="low"]').count()) await effort.selectOption('low');
    await until(async () => { const detail = await invoke('task:read', { taskId }); return detail.task.providerId === providerId && detail.task.model === modelId && detail.task.mode === mode; }, 'provider/model/mode changes persisted');
    record('Actual UI selection', { taskId, providerId, modelId, mode });
  };
  const send = async (stage, prompt) => {
    const before = await invoke('task:read', { taskId }), priorIds = new Set(before.messages.map(message => message.id));
    const turn = { stage, provider: before.task.providerId, model: before.task.model, taskId, prompt, startedAt: new Date().toISOString(), transitions: [], completed: false };
    report.turns.push(turn); save();
    await page.locator('#prompt-input').fill(prompt);
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    report.realModelRuns++; save();
    const started = performance.now(), handled = new Set(); let final, settled = 0;
    try {
      await until(async () => {
        const detail = await invoke('task:read', { taskId });
        const response = detail.messages.filter(message => message.role === 'assistant' && !priorIds.has(message.id)).at(-1);
        if (response) { turn.turnId = response.turnId; turn.latestMessage = response; turn.nativeSessions = detail.task.nativeSessions; }
        const transition = { taskStatus: detail.task.status, messageStatus: response?.status, pending: detail.pending.map(request => request.id) };
        if (JSON.stringify(transition) !== JSON.stringify(turn.transitions.at(-1)?.state)) { turn.transitions.push({ elapsedMs: performance.now() - started, state: transition }); save(); }
        for (const request of detail.pending) {
          if (handled.has(request.id)) continue;
          if (detail.pending.length !== 1 || !knownReadApproval(request, { taskId, turnId: response?.turnId, stage, project })) await unexpectedPending(request, `Unexpected pending request in ${stage}: ${request.title}`);
          const card = page.locator('.pending-card').filter({ has: page.getByRole('heading', { name: request.title, exact: true }) });
          await card.waitFor({ state: 'visible' });
          assert.equal(await card.count(), 1, 'Exactly one matching approval card is required.');
          report.approvals.push({ request, decision: 'Allow once', reason: 'Expected task/turn-scoped Akorith files_read in the disposable project, no attachments or enabled skills.', via: 'UI', at: new Date().toISOString() }); save();
          await card.getByRole('button', { name: 'Allow once', exact: true }).click(); handled.add(request.id);
        }
        if (!response || !terminal.has(detail.task.status)) { settled = 0; return false; }
        const state = await invoke('app:diagnostics');
        turn.finalDiagnostics = state;
        if (!Array.isArray(state.engine?.active) || state.engine.active.some(run => run.taskId === taskId) || state.engine.writerLeases !== 0 || detail.pending.length) { settled = 0; return false; }
        if (++settled < 2) return false;
        turn.message = response; turn.task = detail.task; turn.pending = detail.pending; turn.elapsedMs = performance.now() - started;
        final = { detail, response }; save();
        assert.equal(detail.task.status, 'completed', `${stage}: task status after cleanup; ${JSON.stringify(response.activities)}`);
        assert.equal(response.status, 'completed', `${stage}: assistant message status after cleanup`);
        assert.equal(state.engine.active.length, 0, 'No other run should exist in this disposable app.');
        assert.equal(await page.locator('.transcript-region').count(), 1);
        turn.completed = true; save(); return true;
      }, `${stage}: actual completed status after cleanup`, timeout);
      await page.screenshot({ path: path.join(output, `${String(report.turns.length).padStart(2, '0')}-${stage}.png`) });
      await diagnostics(`after-${stage}`);
      return final;
    } catch (error) { turn.failure = errorText(error); turn.elapsedMs = performance.now() - started; save(); await stopTask(`Failed ${stage}`); throw error; }
  };
  try {
    save();
    report.appAsarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(app, 'Contents', 'Resources', 'app.asar'))).digest('hex');
    const { chromium } = require('playwright-core');
    port = await freePort(); report.port = port; launchAttempted = true;
    cp.execFileSync('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${data}`, '--stdout', path.join(output, 'launch.log'), '--stderr', path.join(output, 'launch.log'), '-a', app, '--args', `--remote-debugging-port=${port}`], { timeout: 10000 });
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'exact packaged CDP', 30000);
    owner = identify(executable, port); report.owner = owner; save();
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    page = browser.contexts()[0].pages().find(candidate => candidate.url().includes('index.html') && candidate.url().startsWith('file:'));
    assert.ok(page, 'Privileged app page must exist.'); page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.errors.push({ kind: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ kind: 'console', message: message.text() }); });
    await page.locator('#prompt-input').waitFor(); await page.bringToFront();
    let snapshot, stable = 0;
    await until(async () => {
      snapshot = await invoke('app:snapshot'); const state = await invoke('app:diagnostics');
      const settled = ['codex', 'claude', 'opencode', 'ollama'].every(id => snapshot.providers.some(provider => provider.id === id && provider.connectionLabel && !/checking/i.test(provider.connectionLabel))) && state.providerRefreshPending === false;
      stable = settled ? stable + 1 : 0; return stable >= 2;
    }, 'all provider discovery settled', 120000);
    assert.equal(snapshot.version, expectedVersion);
    assert.equal(snapshot.projects.length, 0, 'Disposable user data must start with no user projects.');
    assert.ok(Array.isArray(snapshot.settings.skills) && snapshot.settings.skills.length === 0, 'The fresh fixture must have no selected Akorith skill IDs.');
    assert.ok(Array.isArray(snapshot.settings.mcpServers) && snapshot.settings.mcpServers.length === 0, 'The fresh fixture must have no external MCP servers.');
    report.catalog = snapshot.providers; save();
    const codex = snapshot.providers.find(provider => provider.id === 'codex'), ollama = snapshot.providers.find(provider => provider.id === 'ollama'), opencode = snapshot.providers.find(provider => provider.id === 'opencode');
    for (const provider of [codex, ollama, opencode]) assert.ok(provider.available && provider.authenticated !== false, `${provider.id} is not ready: ${provider.error || provider.connectionLabel}`);
    assert.ok(codex.models.some(model => model.id === 'gpt-6-astra'), 'Actual Codex catalog must expose gpt-6-astra.');
    assert.ok(ollama.models.some(model => model.id === 'qwen3:1.7b'), 'Actual Ollama catalog must expose downloaded qwen3:1.7b.');
    const mimo = freeMimo(opencode.models, option('--opencode-model')); report.selectedOpenCodeModel = mimo;
    record('Discovery and billing-route guard', { version: snapshot.version, codex: 'gpt-6-astra', ollama: 'qwen3:1.7b', opencode: mimo.id, fallback: false });
    await diagnostics('discovery-settled');
    const opened = await invoke('project:add', { path: project });
    const created = await invoke('task:create', { projectId: opened.id, providerId: 'codex', model: 'gpt-6-astra' }); taskId = created.id; report.taskId = taskId;
    const title = 'Disposable connected-provider journey';
    await invoke('task:update', { taskId, patch: { title } });
    await page.locator('.task-select').filter({ hasText: title }).click();
    await until(async () => (await page.locator('.task-row.selected .task-title').innerText()).trim() === title, 'fixture task selected');
    await choose('codex', 'gpt-6-astra', 'work');
    let result = await send('codex-initial', 'This is an isolated local verification fixture. Use only Akorith files_read to read source.txt, then Akorith files_write to create handoff.md with the exact same two lines, preserving Turkish text and the reference. Do not use shell, browser, external services or other tools. Reply briefly with the exact reference you read.');
    const nativeCodex = result.detail.task.nativeSessions.codex; assert.ok(nativeCodex, 'Initial native Codex session ID is required.');
    assert.ok(hasTool(result.response, 'files_read') && hasTool(result.response, 'files_write'), 'Codex must execute real Akorith read and write tools.');
    assert.equal(fs.readFileSync(path.join(project, 'handoff.md'), 'utf8'), fs.readFileSync(path.join(project, 'source.txt'), 'utf8'));
    assert.ok(result.response.content.includes(originalReference));
    record('Codex actual file fixture', { taskId, nativeSession: nativeCodex, referenceReadFromFile: true, actualUtf8Write: true });
    await choose('ollama', 'qwen3:1.7b', 'read');
    result = await send('ollama-handoff', 'What exact reference did the previous assistant just read and copy? Answer with that reference only, using the conversation history. Do not use any tools or read files.');
    assert.ok(result.response.content.includes(originalReference), 'Local model must recall the reference from history, not from its current prompt.');
    assert.ok(noTools(result.response), 'This is a history handoff check; no local tool invocation is allowed.');
    record('Ollama history handoff', { taskId, referenceRecalled: true, noTools: true });
    // This second token is introduced on disk only after leaving Codex. Its exact value is
    // omitted from every prompt. Returning Codex must learn it from intervening history.
    fs.appendFileSync(path.join(project, 'handoff.md'), `OpenCode reference: ${laterReference}\n`);
    await choose('opencode', mimo.id, 'read');
    result = await send('opencode-read', 'Use only the task-scoped Akorith files_read tool (akorith_files_read) to read handoff.md. Reply with both exact references found in that file. Do not use native read, shell, browser or any other tool.');
    assert.ok(hasTool(result.response, 'files_read'), 'OpenCode must execute the task-scoped Akorith read tool.');
    assert.ok(result.response.content.includes(originalReference) && result.response.content.includes(laterReference));
    const nativeOpenCode = result.detail.task.nativeSessions.opencode; assert.ok(nativeOpenCode, 'OpenCode native session ID must be persisted.');
    record('OpenCode first turn completed after cleanup', { taskId, model: mimo.id, nativeSession: nativeOpenCode, actualFileRead: true });
    result = await send('opencode-recall', 'What exact OpenCode reference did you just read? Recall it from our previous conversation and answer with only that reference. Do not use any tools or read files.');
    assert.equal(result.detail.task.nativeSessions.opencode, nativeOpenCode, 'Second OpenCode turn must use the same native session.');
    assert.ok(result.response.content.includes(laterReference), 'Second OpenCode turn must recall its previous result.');
    assert.ok(noTools(result.response), 'OpenCode native recall must not reread the fixture.');
    record('OpenCode second turn completed after cleanup', { taskId, nativeSessionPreserved: true, referenceRecalled: true, noTools: true });
    await choose('codex', 'gpt-6-astra', 'read');
    result = await send('codex-return', 'We switched providers in this same task. From the conversation only, return the original reference and the later OpenCode reference. Do not use any tools or read any files.');
    assert.equal(result.detail.task.nativeSessions.codex, nativeCodex, 'Returning Codex must preserve its original native session.');
    assert.ok(result.response.content.includes(originalReference) && result.response.content.includes(laterReference), 'Returning Codex must receive the context introduced by OpenCode.');
    assert.ok(noTools(result.response), 'Returning Codex must answer from the handed-off conversation.');
    record('Codex native resume with intervening context', { taskId, nativeSessionPreserved: true, originalAndLaterReferencesRecalled: true, noTools: true });
    if (process.argv.includes('--with-browser')) {
      await choose('codex', 'gpt-6-astra', 'work');
      result = await send('codex-browser-form', 'Use Akorith preview_start to serve this project’s existing static index.html. Open its returned localhost URL using browser_open. Use browser_snapshot, browser_type and browser_click to fill Fixture name with İstanbul Çığ and submit Confirm local fixture. Take a fresh browser_snapshot after submitting, then reply with the exact resulting confirmation text. Use only those Akorith preview/browser tools. Do not inspect files or scripts, run commands, navigate externally or close the preview yet.');
      for (const tool of ['preview_start', 'browser_open', 'browser_snapshot', 'browser_type', 'browser_click']) assert.ok(hasTool(result.response, tool), `Browser workflow requires actual ${tool}.`);
      assert.ok(!result.response.activities.some(activity => activity.kind === 'command' || /files_(?:read|write)/.test(activity.title)), 'Browser test must not inspect fixture scripts or use shell.');
      const tabs = await invoke('browser:list', { taskId });
      const local = tabs.filter(tab => { try { const url = new URL(tab.url); return ['localhost', '127.0.0.1'].includes(url.hostname); } catch { return false; } });
      assert.equal(local.length, 1, 'Exactly one task-scoped local browser fixture is expected.');
      const target = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === local[0].url);
      assert.ok(target, 'Actual local browser target must be observable through the owned app CDP connection.');
      const observed = await target.evaluate(() => ({ title: document.title, confirmed: document.body.dataset.confirmed, name: document.querySelector('input')?.value, result: document.querySelector('output')?.textContent, privilegedApiAvailable: typeof window.akorith !== 'undefined' }));
      assert.equal(observed.title, 'Akorith synthetic form'); assert.equal(observed.confirmed, 'true'); assert.equal(observed.name, 'İstanbul Çığ'); assert.equal(observed.result, `İstanbul Çığ · ${formReference}`); assert.equal(observed.privilegedApiAvailable, false);
      assert.ok(result.response.content.includes(formReference), 'Model must report the real post-submit confirmation.');
      await target.screenshot({ path: path.join(output, 'actual-local-browser-form.png') });
      record('Codex real task browser form', { taskId, browser: local[0], observed, providerReportedObservedConfirmation: true });
    } else report.browserWorkflow = { status: 'not-run', reason: 'Optional --with-browser was not selected; no browser acceptance claim.' };
    assert.equal(report.turns.length, report.expectedTurns); assert.ok(report.turns.every(turn => turn.completed));
    assert.equal(report.realModelRuns, report.expectedTurns);
    assert.equal(report.errors.length, 0, 'No unexpected renderer or console errors.');
    await diagnostics('all-workflows-complete');
    await page.screenshot({ path: path.join(output, 'connected-workflows-final.png') });
    report.completed = true;
  } catch (error) {
    report.failure = errorText(error); console.error(report.failure);
    if (page) { await stopTask('Harness failure'); await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {}); await diagnostics('failure').catch(error => { report.diagnosticError = errorText(error); }); }
  } finally {
    try { save(); } catch (error) { report.errors.push({ kind: 'report-write', message: errorText(error) }); }
    if (!owner && launchAttempted) { try { owner = identify(executable, port); report.owner = owner; } catch (error) { report.cleanup = { successful: false, confirmedAbsent: false, normalQuitTest: false, failure: errorText(error) }; } }
    if (owner) report.cleanup = await cleanupOwned(owner);
    else if (!launchAttempted) report.cleanup = { successful: true, notLaunched: true, normalQuitTest: false };
    if (browser) { let timer; try { await Promise.race([browser.close().catch(error => { report.disconnectError = errorText(error); }), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); } finally { clearTimeout(timer); } }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = performance.now() - start;
    report.successful = report.completed && !report.errors.length && report.cleanup?.successful === true;
    if (!report.successful) process.exitCode = 1;
    save();
    console.log(JSON.stringify({ protocol: PROTOCOL, completed: report.completed, successful: report.successful, realModelRuns: report.realModelRuns, expectedTurns: report.expectedTurns, output, root, failure: report.failure, cleanup: report.cleanup }, null, 2));
  }
}
module.exports = { main, freeMimo, knownReadApproval, hasTool, noTools };
if (require.main === module) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
