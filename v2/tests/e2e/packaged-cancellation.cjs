#!/usr/bin/env node
/** Real, operator-assisted packaged acceptance. Nothing launches without --run. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
const crypto = require('node:crypto');

const PROTOCOL = {
  name: 'akorith-packaged-cancellation-v1',
  model: 'gpt-6-astra',
  commandSleepSeconds: 90,
  lateWriteObservationMarginMs: 5000,
  nativeQuitOperatorWindowMs: 90000,
  pendingDiscoveryWindowMs: 90000,
  pendingModel: 'opencode/mimo-v2.5-free',
  pendingConditional: 'A catalog entry and prompt cannot guarantee a native approval. No fake event or automatic approval is used.',
  cleanup: 'Exact owned PID identity checks; SIGTERM/SIGKILL recovery is never credited as native Quit.',
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorText = error => error?.stack || String(error);
const shellQuote = value => `'${String(value).replace(/'/g, `'"'"'`)}'`;
function options(argv) {
  const result = { run: false, skipPending: false, pendingModel: PROTOCOL.pendingModel };
  const values = { '--app': 'app', '--expected-version': 'expectedVersion', '--package-id': 'packageId', '--pending-model': 'pendingModel' };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--run') result.run = true;
    else if (flag === '--skip-pending') result.skipPending = true;
    else if (values[flag]) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${flag}`);
      result[values[flag]] = value;
    } else throw Error(`Unknown option: ${flag}`);
  }
  if (!result.run) return result;
  if (!result.app || !path.isAbsolute(result.app) || path.basename(result.app) !== 'Akorith Next.app') throw Error('--app must be the exact absolute Akorith Next.app bundle path.');
  if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result.expectedVersion || '')) throw Error('--expected-version is required; no guessed package version.');
  if (!/^opencode\/[a-zA-Z0-9._-]*free[a-zA-Z0-9._-]*$/.test(result.pendingModel)) throw Error('The optional pending case requires an explicitly named free OpenCode catalog model. No paid fallback.');
  return result;
}
function parseMarker(text, nonce) {
  const match = text.trim().match(/^([a-f0-9]{32}) ([1-9][0-9]*)$/);
  if (!match || match[1] !== nonce || !Number.isSafeInteger(Number(match[2])) || Number(match[2]) <= 1) throw Error('Invalid owned-fixture PID marker.');
  return Number(match[2]);
}
function probe(pid, kill = process.kill) {
  try { kill(pid, 0); return { state: 'alive' }; }
  catch (error) { return error.code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', code: error.code, message: error.message }; }
}
function sameIdentity(expected, current) {
  return !!expected && !!current && expected.pid === current.pid && expected.started === current.started && expected.command === current.command;
}
function pendingMatches(request, proofName) {
  // OpenCode scopes MCP permission by its tool name. Never answer any request,
  // including this expected one; the operator will quit with it still pending.
  return request?.kind === 'approval' && /(?:akorith[_ .·-]*)?files_read\b/i.test(request.title || '') &&
    (!request.detail || request.detail.includes(proofName) || /^[*\s]+$/.test(request.detail));
}
function help() {
  console.log('Real Akorith cancellation acceptance (fresh disposable data only).\n' +
    'node v2/tests/e2e/packaged-cancellation.cjs --run --app "/exact/Akorith Next.app" --expected-version 2.0.0-alpha.3 --package-id B03\n' +
    'Optional: --pending-model opencode/mimo-v2.5-free; --skip-pending records that case not-run.\n' +
    'On "Awaiting native Quit action", root must use real macOS Quit on the reported owned app within 90 seconds.\n' +
    '--self-test checks pure guards only. No app/model launch.');
}

async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (!config.run) { help(); return; }
  if (process.platform !== 'darwin') throw Error('This harness requires macOS LaunchServices.');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'akorith-cancellation-')));
  const data = path.join(root, 'data'), project = path.join(root, 'project');
  fs.mkdirSync(data); fs.mkdirSync(project);
  const reportPath = path.join(root, 'cancellation.json');
  const nonce = crypto.randomBytes(16).toString('hex');
  const report = {
    protocol: PROTOCOL, harnessSha256: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex'),
    startedAt: new Date().toISOString(), ...config, root, data, project, nonce, disposableFixture: true,
    phase: 'preflight', launches: [], submittedModelPrompts: 0, queuedFollowups: 0,
    checks: [], errors: [], cleanup: [], cancellation: { status: 'not-run' }, pendingQuit: { status: 'not-run' }, completed: false,
  };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const record = (name, value = {}) => { const check = { name, at: new Date().toISOString(), ...value }; report.checks.push(check); save(); console.log(JSON.stringify(check)); };
  const command = (file, args) => cp.execFileSync(file, args, { cwd: project, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const identity = pid => {
    const state = probe(pid);
    if (state.state === 'absent') return null;
    if (state.state === 'unknown') throw Error(`PID ${pid} probe is unknown: ${state.code}`);
    try {
      const started = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']).trim();
      const executable = command('/bin/ps', ['-p', String(pid), '-o', 'command=']).trim();
      const [ppid, pgid] = command('/bin/ps', ['-p', String(pid), '-o', 'ppid=,pgid=']).trim().split(/\s+/).map(Number);
      if (!started || !executable || !Number.isSafeInteger(ppid) || !Number.isSafeInteger(pgid)) throw Error('Incomplete process identity');
      return { pid, started, command: executable, ppid, pgid };
    } catch (error) { if (probe(pid).state === 'absent') return null; throw error; }
  };
  async function until(check, label, timeout = 15000, interval = 150) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = await check();
      if (value) return value;
      if (Date.now() >= deadline) throw Error(`Timed out: ${label}`);
      await pause(interval);
    }
  }
  async function unusedPort() {
    return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
  }
  let browser, page, mainOwner, port, launchEntry, launchAttempted = false;
  const jobs = [], taskIds = [];
  const invoke = async (name, payload) => {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(({ name, payload }) => window.akorith.invoke(name, payload), { name, payload }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`IPC ${name} did not settle within 15 seconds`)), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  async function discoverMain() {
    const executable = path.join(config.app, 'Contents', 'MacOS', 'Akorith Next');
    const matches = command('/bin/ps', ['-axo', 'pid=,command=']).split('\n').filter(line =>
      line.includes(executable) && line.includes(`--remote-debugging-port=${port}`) && !line.includes('--type='));
    if (matches.length !== 1) return null;
    return identity(Number(matches[0].trim().split(/\s+/)[0]));
  }
  async function launch() {
    port = await unusedPort();
    const log = path.join(root, `launch-${report.launches.length + 1}.log`);
    const entry = { port, log, startedAt: new Date().toISOString() };
    launchEntry = entry;
    report.launches.push(entry); save();
    launchAttempted = true;
    command('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${data}`, '--stdout', log, '--stderr', log, '-a', config.app, '--args', `--remote-debugging-port=${port}`]);
    // Identify ownership before waiting on CDP; discovery failure still has cleanup ownership.
    mainOwner = await until(discoverMain, 'exact owned application PID', 15000);
    entry.owner = mainOwner; save();
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }, 'renderer CDP', 30000);
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html'));
    assert.ok(page, 'Packaged renderer must exist'); page.setDefaultTimeout(10000);
    page.on('pageerror', error => { report.errors.push({ phase: report.phase, kind: 'pageerror', message: error.message }); save(); });
    await page.locator('#prompt-input').waitFor();
    let stable = 0;
    const snapshot = await until(async () => {
      const [snapshot, diagnostics] = await Promise.all([invoke('app:snapshot'), invoke('app:diagnostics')]);
      assert.equal(snapshot.version, config.expectedVersion, 'Runtime must match the requested bundle version');
      stable = snapshot.providers.every(provider => provider.connectionLabel !== 'Checking') && diagnostics.providerRefreshPending === false ? stable + 1 : 0;
      return stable >= 2 ? snapshot : false;
    }, 'settled provider discovery', 45000);
    entry.version = snapshot.version;
    entry.providers = snapshot.providers.map(({ id, available, authenticated, version, models, error }) => ({ id, available, authenticated, version, models: models.map(model => model.id), error }));
    record('LaunchServices ready', { pid: mainOwner.pid, version: snapshot.version, log });
    return snapshot;
  }
  async function select(task) {
    await page.locator('.task-select').filter({ hasText: task.title }).first().click();
    await until(async () => (await page.locator('.task-row.selected .task-title').innerText()).trim() === task.title, 'selected fixture task');
  }
  async function createTask(projectId, providerId, model, title, mode) {
    let task = await invoke('task:create', { projectId, providerId, model });
    taskIds.push(task.id);
    task = await invoke('task:update', { taskId: task.id, patch: { title } });
    await select(task);
    await page.getByRole('combobox', { name: 'Permission mode', exact: true }).selectOption(mode);
    await until(async () => (await invoke('task:read', { taskId: task.id })).task.mode === mode, 'UI access-mode persistence');
    return task;
  }
  async function submit(prompt, queued = false) {
    if (queued) await page.getByRole('combobox', { name: 'Follow-up behavior', exact: true }).selectOption('queue');
    await page.locator('#prompt-input').fill(prompt);
    await page.getByRole('button', { name: queued ? 'Queue message' : 'Send message', exact: true }).click();
    if (queued) report.queuedFollowups++; else report.submittedModelPrompts++;
    save();
  }
  function rememberJob(pid, label, expectedScript, expectedParent) {
    const current = identity(pid);
    assert.ok(current, `${label} must still be alive`);
    if (expectedScript) assert.ok(current.command.includes(expectedScript), 'PID marker must identify the exact owned fixture script');
    if (expectedParent) assert.equal(current.ppid, expectedParent, 'Sleep PID must be the verified fixture shell child');
    let ancestor = current;
    for (let depth = 0; ancestor && ancestor.pid !== mainOwner.pid && depth < 40; depth++) ancestor = ancestor.ppid > 1 ? identity(ancestor.ppid) : null;
    assert.equal(ancestor?.pid, mainOwner.pid, 'Fixture job must descend from this exact launched app');
    const owner = { ...current, label };
    jobs.push(owner); save();
    return owner;
  }
  function rememberDescendants(owner) {
    const rows = command('/bin/ps', ['-axo', 'pid=,ppid=']).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
    const ids = new Set([owner.pid]);
    for (let pass = 0; pass < 40; pass++) {
      const size = ids.size;
      for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid);
      if (ids.size === size) break;
    }
    return [...ids].filter(pid => pid !== owner.pid).flatMap(pid => {
      const current = identity(pid);
      if (!current) return [];
      // Recheck current ancestry, not just a PID from the earlier ps snapshot.
      const known = rememberJob(pid, 'native Quit descendant');
      return [known];
    });
  }
  async function observeAbsent(owner, label, timeoutMs = 5000, whileAlive) {
    const start = Date.now();
    const receipt = { label, pid: owner.pid, method: 'observation-only', signals: [], timeoutMs, observations: [], confirmedAbsent: false };
    try {
      await until(async () => {
        const state = probe(owner.pid), prior = receipt.observations.at(-1);
        if (!prior || prior.state !== state.state || prior.code !== state.code) receipt.observations.push({ ...state, elapsedMs: Date.now() - start });
        if (state.state === 'absent') {
          receipt.confirmedAbsent = true;
          owner.confirmedAbsentAt = new Date().toISOString();
          return true;
        }
        // EPERM can be transient while macOS reaps a process. It remains unknown
        // through bounded retries; only an actual ESRCH confirms disappearance.
        if (state.state === 'alive' && whileAlive) await whileAlive();
        return false;
      }, label, timeoutMs, whileAlive ? 1000 : 150);
    } catch (error) {
      receipt.error = errorText(error);
      throw error;
    } finally {
      receipt.elapsedMs = Date.now() - start;
      record('Owned PID disappearance observation', receipt);
    }
    return receipt;
  }
  async function stopOwned(owner, label) {
    const receipt = { label, pid: owner.pid, normalQuit: false, confirmedAbsent: false, forced: false, signals: [], observations: [], errors: [] };
    const started = Date.now();
    if (owner.confirmedAbsentAt) {
      // Do not inspect or signal a PID again after absence was already established;
      // macOS may legitimately reuse that number for an unrelated process.
      receipt.confirmedAbsent = true; receipt.previouslyConfirmedAbsentAt = owner.confirmedAbsentAt;
      report.cleanup.push(receipt); save(); return receipt;
    }
    const observe = () => {
      const state = probe(owner.pid);
      const prior = receipt.observations.at(-1);
      if (!prior || prior.state !== state.state || prior.code !== state.code) receipt.observations.push({ ...state, elapsedMs: Date.now() - started });
      receipt.confirmedAbsent = state.state === 'absent';
      if (receipt.confirmedAbsent) owner.confirmedAbsentAt = new Date().toISOString();
      return state;
    };
    const signal = name => {
      if (observe().state === 'absent') return;
      if (!sameIdentity(owner, identity(owner.pid))) throw Error('Identity changed; refusing to signal a potentially reused PID.');
      try { process.kill(owner.pid, name); receipt.signals.push({ name, delivered: true }); }
      catch (error) { receipt.signals.push({ name, delivered: false, code: error.code }); if (error.code !== 'ESRCH') throw error; }
    };
    try {
      if (observe().state !== 'absent') {
        signal('SIGTERM');
        try { await until(() => observe().state === 'absent', `${label} recovery TERM`, 20000); }
        catch { receipt.forced = true; signal('SIGKILL'); await until(() => observe().state === 'absent', `${label} recovery KILL`, 5000); }
      }
    } catch (error) { receipt.errors.push(errorText(error)); observe(); }
    receipt.elapsedMs = Date.now() - started;
    report.cleanup.push(receipt); save();
    return receipt;
  }
  async function cancellation(projectId) {
    report.phase = 'real host cancellation';
    const script = path.join(project, 'cancel-owned.sh');
    const startedFile = path.join(project, 'started.pid'), sleepFile = path.join(project, 'sleep.pid'), lateFile = path.join(project, 'late.marker');
    const lines = ['#!/bin/sh', 'set -eu', `[ "$(/bin/pwd -P)" = ${shellQuote(project)} ] || exit 71`,
      `printf '%s %s\\n' ${shellQuote(nonce)} "$$" > started.pid`, `/bin/sleep ${PROTOCOL.commandSleepSeconds} &`, 'sleep_pid=$!',
      `printf '%s %s\\n' ${shellQuote(nonce)} "$sleep_pid" > sleep.pid`, 'wait "$sleep_pid"', `printf '%s\\n' ${shellQuote(nonce)} > late.marker`, ''];
    fs.writeFileSync(script, lines.join('\n'));
    const exactCommand = `/bin/sh ${shellQuote(script)}`;
    const task = await createTask(projectId, 'codex', PROTOCOL.model, `Cancellation ${nonce.slice(0, 8)}`, 'full');
    report.cancellation = { status: 'running', taskId: task.id, script, exactCommand }; save();
    await submit(`This is an explicitly authorized cancellation test in the disposable workspace ${project}. Use the Akorith host tool terminal_execute exactly once with command ${JSON.stringify(exactCommand)} and timeout 110000. Do not use a native shell tool, change the command, read other paths, create files yourself, or run anything else. The fixture script writes its own PID markers, waits 90 seconds, and would write late.marker. Say briefly that you are starting the test, then call the tool and await its result. The user will stop it while it is running; never retry after cancellation.`);
    await until(async () => {
      const detail = await invoke('task:read', { taskId: task.id });
      if (detail.pending.length) throw Error('Unexpected native request before cancellation fixture started; no request was answered.');
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(detail.task.status)) throw Error(`Model ended before the fixture started (${detail.task.status}).`);
      return fs.existsSync(startedFile) && fs.existsSync(sleepFile);
    }, 'actual long-running host fixture', 120000);
    const startedAt = fs.statSync(startedFile).mtimeMs;
    const shell = rememberJob(parseMarker(fs.readFileSync(startedFile, 'utf8'), nonce), 'fixture shell', script);
    const sleep = rememberJob(parseMarker(fs.readFileSync(sleepFile, 'utf8'), nonce), 'fixture sleep', undefined, shell.pid);
    const { active, activity } = await until(async () => {
      const before = await invoke('task:read', { taskId: task.id });
      const active = before.messages.filter(message => message.role === 'assistant').at(-1);
      const activity = active?.activities.find(item => item.kind === 'tool' && item.title.includes('terminal_execute'));
      return activity ? { active, activity } : false;
    }, 'persisted Akorith terminal_execute activity (native shell fallback does not count)', 10000);
    record('Owned host fixture running', { taskId: task.id, turnId: active.turnId, activityId: activity.id, shell, sleep, scriptStartedAt: new Date(startedAt).toISOString() });
    const first = `QUEUE_A_${nonce}: Reply only A when this message eventually runs. Do not call tools.`;
    const second = `QUEUE_B_${nonce}: Reply only B when this message eventually runs. Do not call tools.`;
    const edited = first.replace('Reply only A', 'Reply only EDITED_A');
    await submit(first, true);
    await until(async () => (await invoke('task:queue', { taskId: task.id })).length === 1, 'first queued follow-up');
    await submit(second, true);
    const accepted = await until(async () => { const queue = await invoke('task:queue', { taskId: task.id }); return queue.length === 2 ? queue : false; }, 'two queued follow-ups');
    assert.deepEqual(accepted.map(turn => turn.prompt), [first, second]);
    await page.locator('.queue-item').filter({ hasText: first }).getByRole('button', { name: 'Edit queued message', exact: true }).click();
    await page.getByRole('textbox', { name: 'Edit queued message', exact: true }).fill(edited);
    await page.locator('.queue-edit').getByRole('button', { name: 'Save', exact: true }).click();
    await until(async () => (await invoke('task:queue', { taskId: task.id }))[0]?.prompt === edited, 'edited queue persistence');
    await page.getByRole('button', { name: 'Move queued message 2 up', exact: true }).click();
    await until(async () => (await invoke('task:queue', { taskId: task.id }))[0]?.prompt === second, 'reordered queue persistence');
    await page.locator('.queue-item').filter({ hasText: edited }).getByRole('button', { name: 'Remove queued message', exact: true }).click();
    await until(async () => { const queue = await invoke('task:queue', { taskId: task.id }); return queue.length === 1 && queue[0].prompt === second; }, 'removed queue persistence');
    assert.equal(fs.existsSync(lateFile), false, 'Stop must happen before the command completes');
    const stoppedAt = Date.now();
    await page.getByRole('button', { name: 'Stop task', exact: true }).click();
    const after = await until(async () => {
      const [detail, queue, diagnostics] = await Promise.all([invoke('task:read', { taskId: task.id }), invoke('task:queue', { taskId: task.id }), invoke('app:diagnostics')]);
      return detail.task.status === 'cancelled' && queue.length === 0 && diagnostics.engine.active.length === 0 && diagnostics.engine.writerLeases === 0 ? { detail, diagnostics } : false;
    }, 'stopped task and released owned writer lease', 30000);
    await Promise.all([shell, sleep].map(job => observeAbsent(job, `${job.label} after UI Stop`)));
    const preserved = after.detail.messages.find(message => message.id === active.id);
    assert.ok(preserved?.activities.some(item => item.id === activity.id), 'Partial tool activity must survive cancellation');
    for (const turn of accepted) {
      const assistant = after.detail.messages.find(message => message.id === `${turn.id}:assistant`);
      assert.equal(assistant?.status, 'cancelled');
      assert.equal(assistant.content, ''); assert.equal(assistant.activities.length, 0, 'Queued follow-up must never run');
    }
    await page.screenshot({ path: path.join(root, 'cancelled.png') });
    record('UI queue and Stop', { queueTurnIds: accepted.map(turn => turn.id), editReorderRemove: true, stoppedMs: Date.now() - stoppedAt, partialActivityPreserved: true, noQueuedTurns: true, noOwnedPids: true, diagnostics: after.diagnostics });
    const deadline = startedAt + PROTOCOL.commandSleepSeconds * 1000 + PROTOCOL.lateWriteObservationMarginMs;
    record('Observing original late-write deadline', { until: new Date(deadline).toISOString() });
    while (Date.now() < deadline) { assert.equal(fs.existsSync(lateFile), false, 'Cancelled fixture wrote late.marker'); await pause(Math.min(500, deadline - Date.now())); }
    assert.equal(fs.existsSync(lateFile), false);
    assert.equal((await invoke('task:queue', { taskId: task.id })).length, 0);
    const finalDiagnostics = await invoke('app:diagnostics');
    assert.equal(finalDiagnostics.engine.active.length, 0); assert.equal(finalDiagnostics.engine.writerLeases, 0);
    report.cancellation = { ...report.cancellation, status: 'passed', turnId: active.turnId, noLateWriteThrough: new Date().toISOString(), observedOriginalDeadline: true };
    record('Real cancellation passed', { ...report.cancellation });
  }
  async function pendingQuit(projectId, snapshot) {
    report.phase = 'conditional native pending Quit';
    const connection = snapshot.providers.find(provider => provider.id === 'opencode');
    if (config.skipPending || !connection?.available || connection.authenticated === false || !connection.models.some(model => model.id === config.pendingModel)) {
      report.pendingQuit = { status: 'not-run', reason: config.skipPending ? 'Explicit --skip-pending' : 'Requested free OpenCode model is not available in the actual authenticated catalog; no fallback.' };
      record('Pending Quit not run', report.pendingQuit); return;
    }
    const proofName = 'approval-proof.txt'; fs.writeFileSync(path.join(project, proofName), `APPROVAL_PROOF_${nonce}\n`);
    const task = await createTask(projectId, 'opencode', config.pendingModel, `Pending Quit ${nonce.slice(0, 8)}`, 'read');
    report.pendingQuit = { status: 'running', taskId: task.id, model: config.pendingModel }; save();
    await submit(`In this disposable workspace, read ${proofName} using only the Akorith MCP server's files_read tool, then quote its contents. Do not use native read, shell, web, or any other tool. If the native runtime asks the user for tool permission, wait for that permission; do not work around it.`);
    let detail, request;
    const deadline = Date.now() + PROTOCOL.pendingDiscoveryWindowMs;
    while (Date.now() < deadline) {
      detail = await invoke('task:read', { taskId: task.id });
      if (detail.pending.length) { request = detail.pending.find(item => pendingMatches(item, proofName)); break; }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(detail.task.status)) break;
      await pause(250);
    }
    if (!request) {
      report.pendingQuit = { ...report.pendingQuit, status: 'not-run', reason: detail?.pending.length ? 'A different native request appeared; it was left unanswered.' : 'The model/native protocol did not produce the expected MCP read approval.', observedStatus: detail?.task.status, observedPending: detail?.pending, observedMessages: detail?.messages };
      record('Pending Quit not run', report.pendingQuit);
      if (detail && ['queued', 'starting', 'running', 'waiting', 'cancelling'].includes(detail.task.status)) {
        await page.getByRole('button', { name: 'Stop task', exact: true }).click();
        await until(async () => !(await invoke('app:diagnostics')).engine.active.some(run => run.taskId === task.id), 'conditional-case cancellation', 30000);
      }
      return;
    }
    assert.equal(detail.task.status, 'waiting');
    await page.getByRole('region', { name: 'Approval requested', exact: true }).waitFor();
    const before = { taskId: task.id, request, messages: detail.messages, nativeSession: detail.task.nativeSessions.opencode };
    const descendants = rememberDescendants(mainOwner);
    before.ownedDescendants = descendants;
    report.pendingQuit.before = before; save();
    await page.screenshot({ path: path.join(root, 'native-pending-before-quit.png') });
    const owner = mainOwner, waitStarted = Date.now();
    record('Awaiting native Quit action', { pid: owner.pid, app: config.app, taskId: task.id, requestId: request.id, nativeRequestKind: request.kind, deadlineMs: PROTOCOL.nativeQuitOperatorWindowMs, method: 'Root CUA must use the actual macOS Quit menu or native Command-Q. This harness sends no Quit key or signal in this phase.' });
    await observeAbsent(owner, 'operator native Quit with pending request', PROTOCOL.nativeQuitOperatorWindowMs, async () => {
        let observed;
        try { observed = await Promise.all([invoke('app:diagnostics'), invoke('task:read', { taskId: task.id })]); }
        catch (error) { report.pendingQuit.lastIpcErrorWhileAwaitingExit = errorText(error); }
        if (observed) {
          const [diagnostics, current] = observed;
          report.pendingQuit.lastQuitObservation = { at: new Date().toISOString(), shutdown: diagnostics.shutdown, pendingIds: current.pending.map(item => item.id) };
          if (diagnostics.shutdown.state === 'idle' && !current.pending.some(item => item.id === request.id)) throw Error('The expected native request disappeared before Quit began; this is not pending-Quit acceptance.');
        }
    });
    launchEntry.confirmedAbsentBy = 'operator native Quit';
    await Promise.all(descendants.map(descendant => observeAbsent(descendant, 'native Quit descendant')));
    record('Native pending Quit process absent', { pid: owner.pid, operatorDriven: true, observationMs: Date.now() - waitStarted, includesOperatorDelay: true, signalSentByHarness: false });
    mainOwner = null; await browser.close(); browser = null; page = null;
    await launch(); await select(task);
    const after = await invoke('task:read', { taskId: task.id });
    assert.ok(['cancelled', 'interrupted'].includes(after.task.status), 'Pending turn must reopen stopped/interrupted');
    assert.deepEqual(after.pending, []); assert.equal(after.task.nativeSessions.opencode, before.nativeSession);
    assert.deepEqual(after.messages.map(message => message.id), before.messages.map(message => message.id), 'No native request or user prompt may be replayed as another turn');
    for (const message of before.messages) {
      const restored = after.messages.find(item => item.id === message.id);
      assert.equal(restored.content, message.content, 'Pending history content must survive native Quit');
      for (const activity of message.activities) assert.ok(restored.activities.some(item => item.id === activity.id), 'Pending history activity must survive native Quit');
    }
    await pause(3000);
    const diagnostics = await invoke('app:diagnostics');
    assert.equal(diagnostics.engine.active.length, 0); assert.equal(diagnostics.engine.writerLeases, 0);
    assert.deepEqual((await invoke('task:read', { taskId: task.id })).pending, []);
    report.pendingQuit = { ...report.pendingQuit, status: 'passed', requestNotReplayed: true, historyPreserved: true, stoppedAfterReopen: true, diagnostics };
    record('Native pending Quit and reopen passed', { taskId: task.id, status: after.task.status, requestNotReplayed: true, historyPreserved: true });
  }
  try {
    save(); console.log(JSON.stringify({ phase: 'fixture-created', report: reportPath, root, data, project }));
    assert.ok(fs.statSync(path.join(config.app, 'Contents', 'MacOS', 'Akorith Next')).isFile());
    report.bundleVersion = command('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(config.app, 'Contents', 'Info.plist')]).trim();
    assert.equal(report.bundleVersion, config.expectedVersion, 'Bundle metadata must match --expected-version');
    report.appAsarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(config.app, 'Contents', 'Resources', 'app.asar'))).digest('hex');
    fs.writeFileSync(path.join(root, 'owned-fixture.json'), JSON.stringify({ protocol: PROTOCOL.name, root, data, project, nonce }, null, 2));
    const snapshot = await launch();
    const codex = snapshot.providers.find(provider => provider.id === 'codex');
    assert.ok(codex?.available && codex.authenticated === true && codex.models.some(model => model.id === PROTOCOL.model), 'Real authenticated Astra must be in the current catalog');
    const opened = await invoke('project:add', { path: project });
    await cancellation(opened.id);
    await pendingQuit(opened.id, snapshot);
    assert.deepEqual(report.errors, []);
    report.completed = true;
  } catch (error) {
    report.failure = { phase: report.phase, message: errorText(error) };
    if (report.cancellation.status === 'running') report.cancellation.status = 'failed';
    if (report.pendingQuit.status === 'running') report.pendingQuit.status = 'failed';
    if (page) {
      await page.screenshot({ path: path.join(root, 'failure.png') }).catch(() => {});
      report.failureDiagnostics = await invoke('app:diagnostics').catch(failure => ({ error: errorText(failure) }));
    }
    record('Harness failed', report.failure);
  } finally {
    report.phase = 'owned recovery cleanup';
    // Cancellation IPC in recovery is separate from the UI Stop under test.
    if (page) for (const taskId of taskIds) {
      let timer;
      try {
        await Promise.race([invoke('task:stop', { taskId }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Recovery Stop timed out')), 15000); })]);
        record('Recovery task Stop acknowledged', { taskId, acceptanceEvidence: false });
      } catch (error) { report.cleanup.push({ taskId, operation: 'task:stop', error: errorText(error), acceptanceEvidence: false }); }
      finally { clearTimeout(timer); }
    }
    if (!mainOwner && launchAttempted && !launchEntry?.confirmedAbsentBy) {
      try { mainOwner = await discoverMain(); } catch (error) { report.cleanup.push({ operation: 'identify-owned-main', error: errorText(error) }); }
    }
    if (mainOwner) {
      if (!mainOwner.confirmedAbsentAt && probe(mainOwner.pid).state === 'alive') {
        try { rememberDescendants(mainOwner); }
        catch (error) { report.cleanup.push({ operation: 'identify-owned-descendants', error: errorText(error) }); }
      }
      const receipt = await stopOwned(mainOwner, 'owned app final/recovery cleanup');
      if (receipt.confirmedAbsent) launchEntry.confirmedAbsentBy ||= 'final/recovery cleanup';
    } else if (launchAttempted && !launchEntry?.confirmedAbsentBy) report.cleanup.push({ operation: 'owned-main', confirmedAbsent: false, error: 'No unique owned main identity; no unscoped signal was sent.' });
    for (const job of jobs) await stopOwned(job, job.label);
    if (browser) {
      let timer;
      try { await Promise.race([browser.close(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CDP disconnect timed out')), 5000); })]); }
      catch (error) { report.cleanup.push({ operation: 'CDP disconnect', error: errorText(error), normalQuit: false }); }
      finally { clearTimeout(timer); }
    }
    report.finishedAt = new Date().toISOString();
    const processReceipts = report.cleanup.filter(item => item.pid);
    report.cleanupComplete = (!launchAttempted || processReceipts.length > 0) && processReceipts.every(item => item.confirmedAbsent && !item.forced && item.errors.length === 0) && !report.cleanup.some(item => item.error);
    report.successful = report.completed && report.cancellation.status === 'passed' && report.pendingQuit.status === 'passed' && report.cleanupComplete && report.errors.length === 0;
    process.exitCode = report.failure || !report.cleanupComplete || report.errors.length ? 1 : report.successful ? 0 : 2;
    save(); console.log(JSON.stringify({ report: reportPath, completed: report.completed, successful: report.successful, cancellation: report.cancellation.status, pendingQuit: report.pendingQuit.status, cleanupComplete: report.cleanupComplete, exitCode: process.exitCode }));
  }
  return report;
}

function selfTest() {
  assert.throws(() => options(['--run']), /--app/);
  assert.throws(() => options(['--run', '--app', '/Applications/Akorith.app', '--expected-version', '2.0.0-alpha.3']), /exact absolute/);
  assert.throws(() => options(['--run', '--app', '/fixture/Akorith Next.app']), /expected-version/);
  assert.throws(() => options(['--run', '--app', '/fixture/Akorith Next.app', '--expected-version', '2.0.0', '--pending-model', 'paid/model']), /No paid fallback/);
  assert.equal(options(['--run', '--app', '/fixture/Akorith Next.app', '--expected-version', '2.0.0']).run, true);
  const nonce = 'a'.repeat(32);
  assert.equal(parseMarker(`${nonce} 345\n`, nonce), 345);
  for (const value of [`${nonce} 1`, `${'b'.repeat(32)} 345`, `${nonce} 345; kill`, '345']) assert.throws(() => parseMarker(value, nonce));
  assert.equal(probe(345, () => { throw Object.assign(Error('not found'), { code: 'ESRCH' }); }).state, 'absent');
  assert.equal(probe(345, () => { throw Object.assign(Error('denied'), { code: 'EPERM' }); }).state, 'unknown');
  assert.equal(sameIdentity({ pid: 2, started: 'before', command: 'owned' }, { pid: 2, started: 'later', command: 'owned' }), false);
  assert.equal(shellQuote("a'b $(x)"), `'a'"'"'b $(x)'`);
  assert.equal(pendingMatches({ kind: 'approval', title: 'Allow akorith_files_read?', detail: '*' }, 'proof.txt'), true);
  assert.equal(pendingMatches({ kind: 'approval', title: 'Allow bash?', detail: 'proof.txt' }, 'proof.txt'), false);
  assert.equal(pendingMatches({ kind: 'question', title: 'Allow files_read?' }, 'proof.txt'), false);
  console.log('Pure cancellation harness guards passed. No filesystem fixture, app, model, or native process launched.');
}
module.exports = { main, options, parseMarker, probe, sameIdentity, pendingMatches, shellQuote, PROTOCOL };
if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
  else main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
}
