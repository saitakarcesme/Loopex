// Real packaged acceptance. Uses only an explicitly named app and new disposable data.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const cp = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const app = argument('--app');
if (!process.argv.includes('--app') || !app?.endsWith('Akorith Next.app')) throw Error('Pass --app with the exact packaged Akorith Next.app path.');
const prior = process.argv.includes('--continue-report') ? JSON.parse(fs.readFileSync(argument('--continue-report'), 'utf8')) : null;
if (prior && (prior.syntheticUserData !== true || !prior.root || prior.data !== path.join(prior.root, 'data') || prior.project !== path.join(prior.root, 'project'))) throw Error('Only continue a matching disposable journey fixture.');
const expectedVersion = process.argv.includes('--expected-version') ? argument('--expected-version') : '2.0.0-alpha.2';
const root = prior?.root || fs.mkdtempSync(path.join(os.tmpdir(), 'akorith-packaged-journey-'));
const data = path.join(root, 'data'), project = path.join(root, 'project');
if (!prior) { fs.mkdirSync(data); fs.mkdirSync(project); }
const report = { startedAt: new Date().toISOString(), app, expectedVersion, root, data, project, syntheticUserData: true, continuedFrom: prior ? argument('--continue-report') : null, realModelRuns: 0, checks: [], errors: [] };
const output = process.argv.includes('--output') ? argument('--output') : root;
fs.mkdirSync(output, { recursive: true });
const save = () => fs.writeFileSync(path.join(output, 'journey.json'), JSON.stringify(report, null, 2) + '\n');
const record = (name, result) => { report.checks.push({ name, at: new Date().toISOString(), ...result }); console.log(JSON.stringify({ check: name, ...result })); save(); };
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };
async function until(check, label, timeout = 15000) {
  const end = Date.now() + timeout;
  while (!(await check())) { if (Date.now() >= end) throw Error('Timed out: ' + label); await delay(100); }
}
async function freePort() {
  return new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
}
let browser, page, pid, launches = 0;
const quitJobPids = [];
async function launch() {
  const port = await freePort(), log = path.join(output, `launch-${++launches}.log`);
  cp.execFileSync('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${data}`, '--stdout', log, '--stderr', log, '-a', app, '--args', `--remote-debugging-port=${port}`]);
  await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) })).ok; } catch { return false; } }, 'packaged CDP', 30000);
  const executable = path.join(app, 'Contents/MacOS/Akorith Next');
  const matches = cp.execFileSync('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(executable) && line.includes(`--remote-debugging-port=${port}`));
  assert.equal(matches.length, 1, 'Identify exactly the owned app process');
  pid = Number(matches[0].trim().split(/\s+/)[0]); report.pid = pid; save();
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  page = browser.contexts()[0].pages().find(page => page.url().includes('index.html'));
  assert.ok(page); page.setDefaultTimeout(10000);
  page.on('pageerror', error => report.errors.push(error.message));
  await page.locator('#prompt-input').waitFor();
  await until(async () => (await invoke('app:snapshot')).providers.every(provider => provider.connectionLabel !== 'Checking'), 'provider discovery', 30000);
  const snapshot = await invoke('app:snapshot');
  assert.equal(snapshot.version, expectedVersion);
  record('LaunchServices discovery', { version: snapshot.version, pid, log, providers: snapshot.providers.map(({ id, available, authenticated, version, error, models }) => ({ id, available, authenticated, version, error, modelCount: models.length })) });
  return snapshot;
}
async function invoke(command, payload) { return page.evaluate(({ command, payload }) => window.akorith.invoke(command, payload), { command, payload }); }
async function selectTask(task) {
  await page.locator('.task-select').filter({ hasText: task.title }).first().click();
  await until(async () => (await page.locator('.task-row.selected .task-title').innerText()).trim() === task.title, 'selected task');
}
async function send(taskId, prompt) {
  const previous = (await invoke('task:read', { taskId })).messages.filter(message => message.role === 'assistant').length;
  await page.locator('#prompt-input').fill(prompt);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  report.realModelRuns++; save();
  let detail;
  await until(async () => {
    detail = await invoke('task:read', { taskId });
    return detail.messages.filter(message => message.role === 'assistant').length > previous && ['completed', 'failed', 'cancelled', 'interrupted'].includes(detail.task.status);
  }, 'real model turn', 120000);
  const response = detail.messages.filter(message => message.role === 'assistant').at(-1);
  record('Real turn', { provider: detail.task.providerId, taskId, turnId: response.turnId, status: detail.task.status, text: response.content, usage: response.usage, errorActivities: response.activities.filter(activity => activity.kind === 'error') });
  assert.equal(detail.task.status, 'completed', JSON.stringify(response.activities));
  assert.equal(await page.locator('.transcript-region').count(), 1);
  return detail;
}
async function normalQuit(expectedNativeDraft) {
  const quittingPid = pid, started = Date.now();
  // CDP key dispatch is not a native macOS menu accelerator. A CUA operator uses
  // the exact running app's Quit action while this harness only observes exit.
  if (process.argv.includes('--native-quit')) {
    record('Awaiting native Quit action', { pid: quittingPid, deadlineMs: 90000, expectedNativeDraft });
    await until(() => !alive(quittingPid), 'native Quit process exit', 90000);
  } else {
    // Kept as an explicitly labeled harness diagnostic, not native Quit evidence.
    await page.keyboard.press('Meta+q').catch(error => { if (alive(quittingPid)) throw error; });
    await until(() => !alive(quittingPid), 'CDP Meta-Q process exit', 20000);
  }
  record(process.argv.includes('--native-quit') ? 'Native Quit process exit' : 'CDP Meta-Q process exit', { pid: quittingPid, observationWindowMs: Date.now() - started, includesOperatorWait: process.argv.includes('--native-quit'), processExited: true });
  for (const job of quitJobPids) assert.equal(alive(job), false, `Owned PTY job ${job} must be gone after normal Quit`);
  if (quitJobPids.length) record('Quit drained live PTY jobs', { ownedJobPids: [...quitJobPids], allAbsent: true });
  await browser.close().catch(() => {}); browser = undefined; page = undefined; pid = undefined;
}
(async () => {
  const snapshot = await launch();
  const codex = snapshot.providers.find(provider => provider.id === 'codex');
  assert.ok(codex.available && codex.authenticated && codex.models.some(model => model.id === 'gpt-6-astra'));
  let task, detail;
  if (prior) {
    const earlier = prior.checks.find(check => check.name === 'Native continuation' || check.name === 'Existing synthetic journey reopened');
    assert.ok(earlier?.taskId, 'The previous real native journey must have completed both turns.');
    detail = await invoke('task:read', { taskId: earlier.taskId }); task = detail.task;
    assert.ok(['Packaged native journey', 'B02 native journey'].includes(task.title));
    await selectTask(task);
    record('Existing synthetic journey reopened', { taskId: task.id, completedPriorTurns: detail.messages.filter(message => message.role === 'assistant' && message.status === 'completed').length, priorBuild: prior.expectedVersion || '2.0.0-alpha.2' });
  } else {
    const opened = await invoke('project:add', { path: project });
    task = await invoke('task:create', { projectId: opened.id, providerId: 'codex', model: 'gpt-6-astra' });
    task = await invoke('task:update', { taskId: task.id, patch: { title: 'Packaged native journey' } });
    await selectTask(task);
    detail = await send(task.id, `Use the workspace file tool to create journey.md containing exactly these two lines: Başlangıç — İstanbul\nSEDEF-482\n. Then return a short confirmation and a clickable Markdown link to ${path.join(project, 'journey.md')}.`);
  }
  const nativeId = detail.task.nativeSessions.codex;
  assert.ok(nativeId);
  const file = path.join(project, 'journey.md');
  assert.match(fs.readFileSync(file, 'utf8'), /SEDEF-482/);
  if (!prior) detail = await send(task.id, 'Read journey.md and append Tamamlandı — Çığ on a new line, preserving the existing reference and Turkish text. Give a short confirmation.');
  assert.equal(detail.task.nativeSessions.codex, nativeId);
  assert.match(fs.readFileSync(file, 'utf8'), /SEDEF-482[\s\S]*Tamamlandı — Çığ/);
  if (!prior) record('Native continuation', { taskId: task.id, nativeSessionPreserved: true, utf8FilePreserved: true });
  report.beforeQuit = await invoke('app:diagnostics');
  await page.locator('#prompt-input').fill('Immediate quit draft — ığüşöç 👩🏽‍💻');
  const expectedDraft = process.argv.includes('--native-quit') ? 'Native immediate draft — ığüşöç 👩🏽‍💻' : 'Immediate quit draft — ığüşöç 👩🏽‍💻';
  await normalQuit(process.argv.includes('--native-quit') ? expectedDraft : undefined);
  await launch();
  await selectTask(task);
  assert.equal(await page.locator('#prompt-input').inputValue(), expectedDraft);
  detail = await invoke('task:read', { taskId: task.id });
  assert.equal(detail.task.status, 'completed');
  assert.equal(detail.task.nativeSessions.codex, nativeId);
  record('Reopen', { exactImmediateDraftRecovered: true, completedTaskRetained: true, nativeSessionRetained: true });
  if (process.argv.includes('--quit-only')) { await normalQuit(); report.completed = true; return; }
  await page.locator('a').filter({ hasText: 'journey.md' }).first().click();
  await page.getByRole('button', { name: 'Edit file', exact: true }).click();
  const editor = page.getByRole('textbox', { name: 'Edit journey.md', exact: true });
  await editor.waitFor();
  const original = await editor.inputValue(), draft = original + '\nLOCAL_DRAFT_715\n';
  await editor.fill(draft);
  fs.appendFileSync(file, '\nEXTERNAL_DISK_926\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await until(async () => (await editor.inputValue()) === draft && (await page.locator('.workspace-panel').innerText()).includes('changed'), 'CAS conflict');
  assert.match(fs.readFileSync(file, 'utf8'), /EXTERNAL_DISK_926/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /LOCAL_DRAFT_715/);
  await page.locator('.file-save-error').getByRole('button', { name: 'Compare with disk', exact: true }).click();
  await page.getByRole('region', { name: 'Current disk contents', exact: true }).waitFor();
  assert.match(await page.getByRole('region', { name: 'Current disk contents', exact: true }).innerText(), /EXTERNAL_DISK_926/);
  assert.equal(await editor.inputValue(), draft);
  record('CAS comparison', { localDraftPreserved: true, externalDiskPreserved: true, explicitComparisonShowsCurrentDisk: true });
  await page.getByRole('button', { name: 'Reload from disk', exact: true }).click();
  await page.getByRole('button', { name: 'Discard draft and reload', exact: true }).click();
  await until(async () => (await editor.inputValue()).includes('EXTERNAL_DISK_926'), 'explicit reload');
  assert.doesNotMatch(await editor.inputValue(), /LOCAL_DRAFT_715/);
  const preserved = fs.readFileSync(file, 'utf8');
  await page.getByRole('button', { name: 'Review 1 changed file', exact: true }).last().click();
  const review = page.getByRole('dialog', { name: 'Changes from this turn', exact: true });
  await review.getByRole('region', { name: 'After this turn', exact: true }).waitFor();
  await review.getByRole('button', { name: 'Undo file', exact: true }).click();
  await review.getByRole('alert').waitFor();
  assert.match(await review.getByRole('alert').innerText(), /changed|newer|conflict/i);
  assert.equal(fs.readFileSync(file, 'utf8'), preserved);
  record('Checkpoint conflict', { externalChangePreserved: true, beforeAndAfterReviewVisible: true, undoRejectedVisibly: true });
  await review.getByRole('button', { name: 'Close', exact: true }).click();

  // Use the built-in preview and real isolated browser surface with deterministic local content.
  fs.writeFileSync(path.join(project, 'index.html'), '<!doctype html><html><title>Journey browser</title><body><h1>Browser fixture</h1><label>Name <input id="name"></label><button id="apply">Apply</button><p id="result">Waiting</p><script>document.querySelector("#apply").onclick=()=>document.querySelector("#result").textContent="Hello "+document.querySelector("#name").value</script></body></html>');
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  await page.getByRole('button', { name: 'Start project preview', exact: true }).click();
  let tabs, nativePage;
  await until(async () => { tabs = await invoke('browser:list', { taskId: task.id }); return tabs.some(tab => tab.title === 'Journey browser' && !tab.loading); }, 'preview browser ready');
  const nativeTab = tabs.find(tab => tab.title === 'Journey browser');
  await until(() => { nativePage = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url() === nativeTab.url); return !!nativePage; }, 'native browser CDP target');
  await nativePage.getByRole('textbox', { name: 'Name', exact: true }).fill('İstanbul 👩🏽‍💻');
  await nativePage.getByRole('button', { name: 'Apply', exact: true }).click();
  assert.equal(await nativePage.locator('#result').innerText(), 'Hello İstanbul 👩🏽‍💻');
  assert.deepEqual(await nativePage.evaluate(() => ({ bridge: typeof window.akorith, node: typeof require })), { bridge: 'undefined', node: 'undefined' });
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('tab', { name: 'Browser', exact: true }).click();
  assert.equal(await nativePage.locator('#name').inputValue(), 'İstanbul 👩🏽‍💻');
  record('Packaged preview browser', { url: nativeTab.url, realFormResult: true, isolatedFromHostBridge: true, hideAndShowPreservedPage: true });

  const attachmentDir = path.join(data, 'attachments', task.id);
  fs.mkdirSync(attachmentDir, { recursive: true });
  const previewImage = path.join(attachmentDir, 'fixture-preview.png');
  await nativePage.screenshot({ path: previewImage });
  const textAttachment = path.join(attachmentDir, 'fixture-notes.txt');
  fs.writeFileSync(textAttachment, 'Read-only attachment fallback fixture');
  const foreignDir = path.join(data, 'attachments', 'another-synthetic-task');
  fs.mkdirSync(foreignDir, { recursive: true });
  const foreignImage = path.join(foreignDir, 'foreign.png');
  fs.copyFileSync(previewImage, foreignImage);
  const attachments = [
    { id: 'fixture-image', name: 'preview.png', path: previewImage, mimeType: 'image/png', size: fs.statSync(previewImage).size },
    { id: 'fixture-text', name: 'notes.txt', path: textAttachment, mimeType: 'text/plain', size: fs.statSync(textAttachment).size },
    { id: 'fixture-foreign', name: 'wrong-task.png', path: foreignImage, mimeType: 'image/png', size: fs.statSync(foreignImage).size },
  ];
  // Seed only this disposable draft; the OS attachment picker is a separate acceptance case.
  await page.evaluate(({ taskId, attachments }) => localStorage.setItem(`akorith.v2.composerDraft.${taskId}`, JSON.stringify({ version: 1, text: 'Attachment preview fixture', attachments, pending: null })), { taskId: task.id, attachments });
  await page.reload();
  await page.getByRole('button', { name: 'Preview preview.png', exact: true }).click();
  const imageDialog = page.getByRole('dialog', { name: 'preview.png', exact: true });
  await until(async () => imageDialog.locator('img').evaluate(image => image.complete && image.naturalWidth > 0), 'read-only attachment image decoded');
  assert.match(await imageDialog.innerText(), /Read-only preview/);
  assert.equal(await imageDialog.locator('textarea, .file-editor').count(), 0);
  await imageDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Preview notes.txt', exact: true }).click();
  const textDialog = page.getByRole('dialog', { name: 'notes.txt', exact: true });
  assert.match(await textDialog.innerText(), /Preview unavailable/);
  await textDialog.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('button', { name: 'Preview wrong-task.png', exact: true }).click();
  const foreignDialog = page.getByRole('dialog', { name: 'wrong-task.png', exact: true });
  await until(async () => (await foreignDialog.innerText()).includes('Preview unavailable'), 'cross-task attachment rejected');
  assert.match(await foreignDialog.innerText(), /outside|selected workspace/i);
  assert.equal(await foreignDialog.locator('img').count(), 0);
  await foreignDialog.getByRole('button', { name: 'Close', exact: true }).click();
  for (const attachment of attachments) await page.getByRole('button', { name: `Remove ${attachment.name}`, exact: true }).click();
  record('Packaged attachment preview', { seededDisposableDraft: true, imageDecoded: true, readOnly: true, unsupportedTextHonest: true, otherTaskImageDenied: true, nativeBrowserOpenDuringDialog: true });

  await page.getByRole('tab', { name: 'Terminal', exact: true }).click();
  await until(async () => (await page.locator('.terminal-panel').innerText()).includes('Connected'), 'packaged PTY ready');
  const startJob = async name => {
    const sessions = await invoke('terminal:list', { taskId: task.id });
    assert.equal(sessions.length, 1);
    const metadata = path.join(project, name);
    await invoke('terminal:write', { taskId: task.id, id: sessions[0].id, data: `/bin/sh -c 'trap "" TERM; echo $$ > ${name}; while :; do /bin/sleep 1; done' &\r` });
    await until(() => fs.existsSync(metadata), 'owned terminal job metadata');
    const job = Number(fs.readFileSync(metadata, 'utf8').trim());
    assert.ok(Number.isSafeInteger(job) && job > 1 && alive(job));
    return job;
  };
  const closedJob = await startJob('terminal-close.pid');
  await page.getByRole('button', { name: 'Close terminal session', exact: true }).click();
  await until(async () => (await invoke('terminal:list', { taskId: task.id })).length === 0, 'terminal close acknowledgement');
  assert.equal(alive(closedJob), false);
  record('Packaged PTY close', { jobIgnoredTerm: true, ownedJobPid: closedJob, jobAbsentBeforeAcknowledgement: true });
  await page.getByRole('button', { name: 'Start a new terminal', exact: true }).click();
  await until(async () => (await invoke('terminal:list', { taskId: task.id })).length === 1, 'replacement terminal');
  quitJobPids.push(await startJob('terminal-quit.pid'));
  const computer = await invoke('computer:state', { taskId: task.id });
  record('Packaged computer permission state', { accessibility: computer.accessibility, screenRecording: computer.screenRecording, paused: computer.paused, error: computer.error });
  await page.screenshot({ path: path.join(output, 'packaged-journey.png') });
  assert.deepEqual(report.errors, []);
  await normalQuit();
  report.completed = true;
})().catch(async error => {
  report.completed = false; report.failure = error.stack || String(error); process.exitCode = 1;
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    report.failureDiagnostics = await invoke('app:diagnostics').catch(error => ({ error: String(error) }));
  }
  console.error(report.failure);
}).finally(async () => {
  // Failure cleanup is separately identified and never credited as normal Quit evidence.
  if (pid && alive(pid)) {
    process.kill(pid, 'SIGTERM');
    try { await until(() => !alive(pid), 'failure SIGTERM cleanup', 20000); report.failureCleanup = 'SIGTERM exited'; }
    catch { report.failureCleanup = 'Owned app still alive; inspect recorded PID before further action'; }
  }
  await browser?.close().catch(() => {});
  report.finishedAt = new Date().toISOString(); save();
  console.log(JSON.stringify({ completed: report.completed, output, root, realModelRuns: report.realModelRuns, failure: report.failure, failureCleanup: report.failureCleanup }));
});
