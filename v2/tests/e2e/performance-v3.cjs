#!/usr/bin/env node
/** Synthetic UI performance, protocol 3. No Send, model turn, or user workspace. */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const PROTOCOL = {
  version: 3,
  name: 'akorith-synthetic-search-switch-v3',
  comparison: 'B01 used a different sidebar and measurement protocol. These results cannot be compared directly with B01.',
  taskCount: 1000, messageCount: 10000, defaultSoakMs: 120000,
  fixtureReader: 'Project Electron RUN_AS_NODE with project better-sqlite3, readonly=true and fileMustExist=true; canonical database path, normal WAL handling, no immutable option.',
  launch: 'LaunchServices open invocation to visible composer; app.asar is hashed before launch, so this is not a cold filesystem-cache measurement.',
  warmupIndices: [0, 3], sampleIndices: [0, 1, 2, 3, 0, 1, 2, 3, 0],
  discovery: 'All four provider catalogs must leave Checking and app:diagnostics.providerRefreshPending must be false for two consecutive polls.',
  reveal: 'Open real Search tasks UI, fill exact synthetic title, await its unique visible result and two animation frames.',
  switch: 'Capture-phase click on that search result to two animation frames after selected sidebar title and all mounted transcript task IDs match.',
  input: 'Input event to two animation frames; not keydown-to-paint or model latency.',
  scroll: 'Programmatic transcript scrollTop change to two animation frames; not wheel or trackpad latency.',
  cleanup: 'SIGTERM of the exact owned main PID, bounded wait for ESRCH; forced SIGKILL is recorded as failure. This is not normal Quit testing.',
};
const option = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const distribution = values => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const percentile = ratio => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio))] : null;
  return { samples: sorted.length, p50: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null };
};
const errorText = error => error?.stack || String(error);
function help() {
  console.log('Synthetic Akorith performance, protocol 3. Does not run models.\nUsage: node performance-v3.cjs --run --app "/path/Akorith Next.app" --user-data "/tmp/akorith-performance-..." [--soak-ms 120000] [--output "/tmp/report-dir"] [--package-id B02]\nUse three freshly seeded directories with the same app, default soak and protocol. B01 is not directly comparable.');
}
async function unusedPort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
function ownedPid(executable, port) {
  const matches = cp.execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 3000 }).split('\n')
    .filter(line => line.includes(executable) && line.includes(`--remote-debugging-port=${port}`))
    .map(line => Number(line.trim().split(/\s+/)[0]));
  if (matches.length !== 1) throw new Error(`Could not identify exactly one owned test process (${matches.length} found).`);
  return matches[0];
}
function identity(pid) {
  return cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart=,command='], { encoding: 'utf8', timeout: 3000 }).trim();
}
function probe(pid) {
  try { process.kill(pid, 0); return { state: 'alive' }; }
  catch (error) { return error.code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', code: error.code, error: error.message }; }
}
async function stopOwnedMain(pid, expectedIdentity) {
  const start = performance.now();
  const result = { pid, method: 'SIGTERM', normalQuitTest: false, forced: false, confirmedAbsent: false, signals: [], probes: [], errors: [] };
  const observe = () => {
    const value = probe(pid), previous = result.probes.at(-1);
    if (!previous || value.state !== previous.state || value.code !== previous.code) result.probes.push({ ...value, elapsedMs: performance.now() - start });
    if (value.state === 'absent') result.confirmedAbsent = true;
    return value;
  };
  const signal = name => {
    if (observe().state === 'absent') return;
    // A PID found through this launch's executable + random CDP port is owned. A reused PID is not.
    let current;
    try { current = identity(pid); } catch (error) { if (observe().state === 'absent') return; throw error; }
    if (!expectedIdentity || current !== expectedIdentity) throw new Error('Owned main identity changed; refusing to signal a potentially reused PID.');
    try { process.kill(pid, name); result.signals.push({ signal: name, elapsedMs: performance.now() - start, delivered: true }); }
    catch (error) { result.signals.push({ signal: name, elapsedMs: performance.now() - start, delivered: false, code: error.code }); if (error.code === 'ESRCH') result.confirmedAbsent = true; else result.errors.push(errorText(error)); }
  };
  const wait = async timeoutMs => {
    const deadline = performance.now() + timeoutMs;
    while (!result.confirmedAbsent && performance.now() < deadline) { observe(); if (!result.confirmedAbsent) await pause(100); }
    observe();
  };
  try {
    signal('SIGTERM');
    await wait(30000);
    if (!result.confirmedAbsent) { result.forced = true; signal('SIGKILL'); await wait(5000); }
  } catch (error) { result.errors.push(errorText(error)); observe(); }
  result.elapsedMs = performance.now() - start;
  result.successful = result.confirmedAbsent && !result.forced && result.errors.length === 0;
  result.scope = 'Main PID only. This does not independently certify child-process quiescence or normal application Quit.';
  return result;
}
function fixtureCounts(data, provenance = () => {}) {
  const electron = require('electron');
  const sqliteModule = require.resolve('better-sqlite3');
  const database = fs.realpathSync(path.join(data, 'workspace.sqlite'));
  // Static code plus argv, never shell interpolation. Use the same Electron ABI as
  // Store and preserve SQLite's normal WAL visibility; immutable would be unsafe.
  const script = `
    const Database = require(process.argv[1]);
    const db = new Database(process.argv[2], { readonly: true, fileMustExist: true });
    let result;
    try {
      const counts = db.prepare('SELECT (SELECT COUNT(*) FROM tasks) AS tasks, (SELECT COUNT(*) FROM messages) AS messages, (SELECT COUNT(*) FROM turns) AS turns').get();
      result = { counts, runtime: { electron: process.versions.electron, node: process.versions.node, modules: process.versions.modules, databasePath: process.argv[2], readonly: db.readonly, fileMustExist: true, immutable: false } };
    } finally { db.close(); }
    process.stdout.write(JSON.stringify(result));
  `;
  const output = cp.execFileSync(electron, ['-e', script, sqliteModule, database], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024 }).trim();
  const result = JSON.parse(output);
  const values = ['tasks', 'messages', 'turns'].map(key => result.counts?.[key]);
  if (values.some(value => !Number.isSafeInteger(value) || value < 0) || result.runtime?.readonly !== true) throw new Error(`Invalid read-only synthetic fixture counts: ${output}`);
  provenance({ reader: 'better-sqlite3', electronExecutable: electron, sqliteModule, ...result.runtime });
  return { tasks: values[0], messages: values[1], turns: values[2] };
}
function memorySample(value) {
  if (!Number.isFinite(value.mainMemory?.rss) || value.mainMemory.rss <= 0 || !Array.isArray(value.processes)) throw new Error('app:diagnostics must provide actual main RSS and process metrics.');
  const renderers = value.processes.filter(process => ['Tab', 'Renderer'].includes(process.type));
  const missing = renderers.filter(process => !Number.isFinite(process.memory?.workingSetSize) || process.memory.workingSetSize <= 0);
  return {
    mainRssBytes: value.mainMemory.rss,
    rendererRssBytes: renderers.length && !missing.length ? renderers.reduce((sum, process) => sum + process.memory.workingSetSize * 1024, 0) : null,
    rendererPids: renderers.map(process => process.pid),
    rendererMeasurement: renderers.length && !missing.length ? 'Electron workingSetSize KiB converted to bytes; includes every reported Tab/Renderer process' : 'unavailable: no renderer metrics or a missing/invalid workingSetSize; no zero substitution',
    diagnostics: value,
  };
}
async function main() {
  if (!process.argv.includes('--run')) { help(); return; }
  const appPath = path.resolve(option('--app', process.env.AKORITH_TEST_APP || ''));
  const executable = path.join(appPath, 'Contents', 'MacOS', 'Akorith Next');
  const dataArgument = option('--user-data', process.env.AKORITH_TEST_DATA);
  const data = dataArgument ? path.resolve(dataArgument) : null;
  const soakMs = Number(option('--soak-ms', String(PROTOCOL.defaultSoakMs)));
  // Establish a report before any preflight reads. The default lives outside the
  // unvalidated user-data path, so rejecting a non-fixture never writes into it.
  const outputArgument = option('--output');
  const output = outputArgument ? path.resolve(outputArgument) : fs.mkdtempSync(path.join(os.tmpdir(), 'akorith-performance-report-'));
  fs.mkdirSync(output, { recursive: true });
  const reportPath = path.join(output, 'performance.json');
  const report = { protocol: PROTOCOL, protocolSha256: crypto.createHash('sha256').update(JSON.stringify(PROTOCOL)).digest('hex'), harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'), packageId: option('--package-id', 'B02'), synthetic: null, modelRuns: 0, fixture: null, fixtureReader: {}, appPath, userData: data, startedAt: new Date().toISOString(), requestedSoakMs: soakMs, standardSoak: soakMs === PROTOCOL.defaultSoakMs, phase: 'preflight', errors: [], memory: [], warmups: [], switches: [], scrolls: [], input: null, frames: null, completed: false, successful: false };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  let browser, page, pid, processIdentity, port, fixture, counts, launchAttempted = false;
  const start = performance.now();
  try {
    save();
    if (process.platform !== 'darwin') throw new Error('This harness measures the macOS LaunchServices build.');
    if (!data) throw new Error('--user-data must point to a directory created by seed-performance.ts.');
    if (!appPath.endsWith('.app') || !fs.existsSync(executable)) throw new Error('--app must identify the packaged Akorith Next.app.');
    fixture = JSON.parse(fs.readFileSync(path.join(data, 'synthetic-performance.json'), 'utf8'));
    report.fixture = fixture;
    if (fixture.synthetic !== true || fixture.modelRuns !== 0 || typeof fixture.userData !== 'string' || path.resolve(fixture.userData) !== data) throw new Error('Refusing data without a matching synthetic fixture marker.');
    report.synthetic = true;
    if (fixture.taskCount !== PROTOCOL.taskCount || fixture.messageCount !== PROTOCOL.messageCount || fixture.heavyMessageCount !== 1000 || !Array.isArray(fixture.switchTaskIds) || new Set(fixture.switchTaskIds).size !== 4 || fixture.switchTaskIds[0] !== fixture.heavyTaskId) throw new Error('Protocol 3 requires the current 1000-task/10000-message seed, 1000-message heavy task, and four distinct switch targets.');
    counts = fixtureCounts(data, value => { report.fixtureReader.before = value; });
    report.verifiedCountsBefore = counts;
    if (counts.tasks !== 1000 || counts.messages !== 10000 || counts.turns !== 5000) throw new Error(`Actual synthetic database counts do not match protocol 3: ${JSON.stringify(counts)}`);
    if (!Number.isFinite(soakMs) || soakMs < 1000 || soakMs > 1800000) throw new Error('--soak-ms must be between 1000 and 1800000. Comparable runs use 120000.');
    report.phase = 'launch'; save();
    const { chromium } = require('playwright-core');
    port = await unusedPort();
    report.port = port;
    report.appAsarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(appPath, 'Contents', 'Resources', 'app.asar'))).digest('hex');
    const launchStart = performance.now();
    launchAttempted = true;
    // No -g: this test deliberately foregrounds its isolated synthetic application.
    cp.execFileSync('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${data}`, '--stdout', path.join(output, 'launch.log'), '--stderr', path.join(output, 'launch.log'), '-a', appPath, '--args', `--remote-debugging-port=${port}`], { timeout: 10000 });
    let endpoint;
    const discoveryDeadline = performance.now() + 30000;
    while (performance.now() < discoveryDeadline) {
      try { const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) }); endpoint = (await response.json()).webSocketDebuggerUrl; if (endpoint) break; } catch {}
      await pause(150);
    }
    if (!endpoint) throw new Error('Packaged app did not expose CDP within 30 seconds. See launch.log.');
    pid = ownedPid(executable, port); processIdentity = identity(pid);
    report.pid = pid; report.processIdentity = processIdentity;
    browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    page = context.pages().find(candidate => candidate.url().includes('index.html')) || await context.waitForEvent('page', { timeout: 15000 });
    page.on('pageerror', error => report.errors.push({ type: 'pageerror', message: error.message }));
    page.on('console', message => { if (message.type() === 'error') report.errors.push({ type: 'console', message: message.text() }); });
    await page.waitForSelector('#prompt-input', { timeout: 30000 });
    await page.bringToFront();
    report.launchReadyMs = performance.now() - launchStart;
    report.launchDom = await page.evaluate(() => ({ elements: document.querySelectorAll('*').length, taskRows: document.querySelectorAll('.task-row').length, messages: document.querySelectorAll('article.message').length, visibility: document.visibilityState, width: innerWidth, height: innerHeight, devicePixelRatio }));
    const settleStart = performance.now(); let snapshot, stable = 0;
    report.providerDiscovery = { observations: [], settled: false };
    while (performance.now() - settleStart < 120000) {
      const state = await page.evaluate(async () => ({ snapshot: await window.akorith.invoke('app:snapshot', {}), diagnostics: await window.akorith.invoke('app:diagnostics', {}) }));
      snapshot = state.snapshot;
      const providers = snapshot.providers.map(provider => ({ id: provider.id, connectionLabel: provider.connectionLabel, available: provider.available, authenticated: provider.authenticated, error: provider.error, models: provider.models.length }));
      const status = { providers, refreshPending: state.diagnostics.providerRefreshPending };
      if (JSON.stringify(status) !== JSON.stringify(report.providerDiscovery.observations.at(-1)?.state)) report.providerDiscovery.observations.push({ elapsedMs: performance.now() - settleStart, state: status });
      const settled = ['codex', 'claude', 'opencode', 'ollama'].every(id => providers.some(provider => provider.id === id && typeof provider.connectionLabel === 'string' && provider.connectionLabel.length && !/checking/i.test(provider.connectionLabel))) && state.diagnostics.providerRefreshPending === false;
      stable = settled ? stable + 1 : 0;
      if (stable >= 2) { report.providerDiscovery.settled = true; report.providerDiscovery.providers = providers; break; }
      await pause(500);
    }
    report.providerDiscovery.afterUiReadyMs = performance.now() - settleStart;
    report.providerDiscovery.afterLaunchMs = performance.now() - launchStart;
    if (!report.providerDiscovery.settled) throw new Error('Provider discovery did not settle within 120 seconds; interaction measurements were not started.');
    report.phase = 'interactions';
    if (snapshot.tasks.length !== 1000) throw new Error(`Expected 1000 synthetic tasks, got ${snapshot.tasks.length}.`);
    const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
    report.samplePath = PROTOCOL.sampleIndices.map(index => ({ fixtureIndex: index, taskId: fixture.switchTaskIds[index], title: tasks.get(fixture.switchTaskIds[index])?.title }));
    await page.evaluate(() => {
      const state = window.__akorithSyntheticPerf = { frames: [], input: [], longTasks: [], visibilityChanges: [], last: performance.now(), stopped: false, droppedFrameSamples: 0 };
      if (document.visibilityState !== 'visible') throw new Error('Performance page must be visible.');
      const frame = now => { if (state.stopped) return; if (state.frames.length < 40000) state.frames.push(now - state.last); else state.droppedFrameSamples++; state.last = now; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      document.addEventListener('visibilitychange', () => state.visibilityChanges.push({ at: performance.now(), state: document.visibilityState }));
      document.addEventListener('input', event => { if (event.target?.id !== 'prompt-input') return; const at = performance.now(); requestAnimationFrame(() => requestAnimationFrame(() => state.input.push(performance.now() - at))); }, true);
      try { new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(entry => ({ duration: entry.duration, startTime: entry.startTime })))).observe({ type: 'longtask', buffered: false }); } catch { state.longTasksUnavailable = true; }
    });
    const diagnostics = async label => {
      const value = await page.evaluate(() => window.akorith.invoke('app:diagnostics', {}));
      if (value.providerRefreshPending !== false) throw new Error('Provider discovery restarted during a measured interaction.');
      report.memory.push({ label, elapsedMs: performance.now() - start, ...memorySample(value) });
    };
    const select = async (taskId, measured = true) => {
      const task = tasks.get(taskId); if (!task) throw new Error(`Synthetic task missing: ${taskId}`);
      const revealStart = performance.now();
      await page.getByRole('button', { name: /^Search tasks/ }).click({ timeout: 15000 });
      await page.getByRole('textbox', { name: 'Search tasks and projects' }).fill(task.title);
      const result = page.locator('.search-result').filter({ has: page.getByText(task.title, { exact: true }) });
      await result.waitFor({ state: 'visible', timeout: 15000 });
      if (await result.count() !== 1) throw new Error(`Search did not produce one exact result for ${task.title}.`);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const revealMs = performance.now() - revealStart;
      // Capture the actual user-input click before React's handler. Playwright lookup, search,
      // actionability checks and dispatch overhead do not enter click-to-render duration.
      await page.evaluate(({ id, title }) => {
        const state = window.__akorithSyntheticSwitch = { clickedAt: null, readyAt: null, cancelled: false };
        const clicked = event => {
          const button = event.target?.closest('.search-result');
          if (button?.querySelector('strong')?.textContent !== title) return;
          document.removeEventListener('click', clicked, true);
          state.clickedAt = performance.now();
          const frame = () => {
            if (state.cancelled) return;
            const messages = [...document.querySelectorAll('article.message')];
            if (document.querySelector('.task-row.selected .task-title')?.textContent?.trim() === title && messages.length > 0 && messages.every(message => message.getAttribute('data-task-id') === id) && !document.querySelector('.search-dialog')) {
              requestAnimationFrame(() => { state.readyAt = performance.now(); state.elements = document.querySelectorAll('*').length; state.taskRows = document.querySelectorAll('.task-row').length; state.messages = document.querySelectorAll('article.message').length; state.transcriptRegions = document.querySelectorAll('.transcript-region').length; });
            } else requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        };
        state.detach = () => { state.cancelled = true; document.removeEventListener('click', clicked, true); };
        document.addEventListener('click', clicked, true);
      }, { id: taskId, title: task.title });
      const dispatchStart = performance.now();
      try {
        await result.click({ timeout: 15000 });
        const automationClickMs = performance.now() - dispatchStart;
        await page.waitForFunction(() => Number.isFinite(window.__akorithSyntheticSwitch?.readyAt), null, { timeout: 15000 });
        const value = await page.evaluate(() => { const { detach, ...value } = window.__akorithSyntheticSwitch; return value; });
        if (!Number.isFinite(value.clickedAt)) throw new Error('No actual search-result click was captured.');
        const sample = { taskId, title: task.title, revealMs, automationClickMs, durationMs: value.readyAt - value.clickedAt, elements: value.elements, taskRows: value.taskRows, messages: value.messages, transcriptRegions: value.transcriptRegions };
        (measured ? report.switches : report.warmups).push(sample);
        if (sample.transcriptRegions !== 1 || sample.messages > 100 || sample.taskRows > 31) throw new Error(`Unexpected bounded mount: ${sample.transcriptRegions} transcript regions, ${sample.messages} messages, ${sample.taskRows} task rows.`);
      } finally { await page.evaluate(() => window.__akorithSyntheticSwitch?.detach()).catch(() => {}); }
    };
    const scroll = async bottom => {
      const value = await page.evaluate(bottom => new Promise(resolve => {
        const region = document.querySelector('.transcript-region'); if (!region) throw new Error('Transcript region missing.');
        const owner = [region, ...region.querySelectorAll('*')].find(element => element.scrollHeight > element.clientHeight + 10 && ['auto', 'scroll'].includes(getComputedStyle(element).overflowY));
        if (!owner) { resolve({ scrollable: false }); return; }
        const before = performance.now(); owner.scrollTop = bottom ? owner.scrollHeight : 0;
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ scrollable: true, bottom, durationMs: performance.now() - before, scrollTop: owner.scrollTop, scrollHeight: owner.scrollHeight, viewportHeight: owner.clientHeight })));
      }), bottom);
      report.scrolls.push(value);
    };
    await diagnostics('discovery-settled');
    for (const index of PROTOCOL.warmupIndices) await select(fixture.switchTaskIds[index], false);
    // All runs take the exact same search/click path, independent of prior sidebar selection.
    for (const index of PROTOCOL.sampleIndices) await select(fixture.switchTaskIds[index]);
    const prompt = page.locator('#prompt-input');
    await prompt.fill('');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { window.__akorithSyntheticPerf.input = []; resolve(); }))));
    const typingStarted = performance.now();
    await prompt.pressSequentially('SYNTHETIC ONLY — İstanbul ığüşöç 👩🏽‍💻 🌍', { delay: 20 });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const inputSamples = await page.evaluate(() => window.__akorithSyntheticPerf.input);
    if (!inputSamples.length) throw new Error('No composer input events were measured.');
    report.input = { durationMs: performance.now() - typingStarted, eventToTwoFramesMs: distribution(inputSamples), samplesMs: inputSamples, draftSubmitted: false };
    await prompt.fill('');
    await scroll(false); await scroll(true);
    if (!report.scrolls.every(sample => sample.scrollable)) throw new Error('Heavy synthetic transcript did not provide a scrollable viewport.');
    await diagnostics('after-interactions');
    const soakStart = performance.now(); let sample = 0;
    while (performance.now() - soakStart < soakMs) {
      await pause(Math.min(5000, Math.max(0, soakMs - (performance.now() - soakStart))));
      await scroll(sample % 2 !== 0);
      await diagnostics(`soak-${++sample}`);
      save();
    }
    report.actualSoakMs = performance.now() - soakStart;
    const measured = await page.evaluate(() => { const state = window.__akorithSyntheticPerf; state.stopped = true; return { frames: state.frames, longTasks: state.longTasks, longTasksUnavailable: state.longTasksUnavailable, droppedFrameSamples: state.droppedFrameSamples, visibility: document.visibilityState, visibilityChanges: state.visibilityChanges }; });
    report.frames = { intervalMs: distribution(measured.frames), over50ms: measured.frames.filter(value => value > 50).length, over100ms: measured.frames.filter(value => value > 100).length, droppedSamples: measured.droppedFrameSamples, longTasks: measured.longTasks, longTasksUnavailable: measured.longTasksUnavailable || false, visibility: measured.visibility, visibilityChanges: measured.visibilityChanges };
    if (measured.visibility !== 'visible' || measured.visibilityChanges.some(change => change.state !== 'visible')) throw new Error('The performance page became hidden; samples are not comparable foreground measurements.');
    report.taskSwitchMs = distribution(report.switches.map(sample => sample.durationMs));
    report.taskRevealMs = distribution(report.switches.map(sample => sample.revealMs));
    report.scrollPaintMs = distribution(report.scrolls.filter(sample => sample.scrollable).map(sample => sample.durationMs));
    const initialMemory = report.memory[0], lastMemory = report.memory.at(-1);
    report.memoryDeltaBytes = { main: lastMemory.mainRssBytes - initialMemory.mainRssBytes, renderer: lastMemory.rendererRssBytes === null || initialMemory.rendererRssBytes === null ? null : lastMemory.rendererRssBytes - initialMemory.rendererRssBytes };
    report.finalDom = await page.evaluate(() => ({ elements: document.querySelectorAll('*').length, taskRows: document.querySelectorAll('.task-row').length, messages: document.querySelectorAll('article.message').length, transcriptRegions: document.querySelectorAll('.transcript-region').length }));
    await page.screenshot({ path: path.join(output, 'synthetic-final.png') });
    report.completed = true;
  } catch (error) { report.failureStage = report.phase; report.failure = errorText(error); }
  finally {
    report.measurementElapsedMs = performance.now() - start;
    // A report write failure must never skip teardown of an application we launched.
    try { save(); } catch (error) { report.errors.push({ type: 'report-write', message: errorText(error) }); }
    if (!pid && launchAttempted) {
      try { pid = ownedPid(executable, port); processIdentity = identity(pid); report.pid = pid; }
      catch (error) { report.cleanup = { successful: false, confirmedAbsent: false, normalQuitTest: false, failure: `Unable to establish launch ownership: ${errorText(error)}` }; }
    }
    if (pid) report.cleanup = await stopOwnedMain(pid, processIdentity);
    else if (!launchAttempted) report.cleanup = { successful: true, notLaunched: true, normalQuitTest: false };
    if (browser) {
      let timer;
      try { await Promise.race([browser.close().catch(error => { report.cdpDisconnectError = errorText(error); }), new Promise(resolve => { timer = setTimeout(resolve, 5000); })]); }
      finally { clearTimeout(timer); }
    }
    if (report.cleanup?.confirmedAbsent) {
      try {
        report.verifiedCountsAfter = fixtureCounts(data, value => { report.fixtureReader.after = value; });
        report.noTurnsSubmitted = JSON.stringify(report.verifiedCountsAfter) === JSON.stringify(counts);
        if (!report.noTurnsSubmitted) report.errors.push({ type: 'fixture-integrity', message: 'Synthetic task/message/turn counts changed.' });
      } catch (error) { report.errors.push({ type: 'fixture-integrity', message: errorText(error) }); }
    }
    report.elapsedMs = performance.now() - start;
    report.successful = report.completed && report.errors.length === 0 && report.cleanup?.successful === true && report.noTurnsSubmitted === true;
    if (!report.successful) process.exitCode = 1;
    save();
    console.log(JSON.stringify({ protocolVersion: 3, synthetic: report.synthetic, modelRuns: 0, completed: report.completed, successful: report.successful, output, launchReadyMs: report.launchReadyMs, providerDiscoveryMs: report.providerDiscovery?.afterUiReadyMs, taskRevealMs: report.taskRevealMs, taskSwitchMs: report.taskSwitchMs, input: report.input?.eventToTwoFramesMs, frames: report.frames && { intervalMs: report.frames.intervalMs, over50ms: report.frames.over50ms, over100ms: report.frames.over100ms }, memoryDeltaBytes: report.memoryDeltaBytes, cleanup: report.cleanup, errors: report.errors, failureStage: report.failureStage, failure: report.failure }, null, 2));
  }
}

module.exports = { main, PROTOCOL, distribution, memorySample, fixtureCounts };
if (require.main === module) main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
