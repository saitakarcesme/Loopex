#!/usr/bin/env node
/** Real packaged UI over newly imported synthetic history. No model submissions. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const protocol = 'akorith-packaged-history-display-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const errorText = error => error?.stack || String(error);
function options(args) {
  const result = { run: false };
  const values = { '--app': 'app', '--expected-version': 'expectedVersion', '--package-id': 'packageId' };
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (seen.has(key)) throw Error(`Repeated option: ${key}`);
    seen.add(key);
    if (key === '--run') result.run = true;
    else if (values[key]) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw Error(`Missing value for ${key}`);
      result[values[key]] = value;
    } else throw Error(`Unknown option: ${key}. Existing fixture/source/user-data overrides are not accepted.`);
  }
  if (result.run) {
    if (!result.app || !path.isAbsolute(result.app) || path.basename(result.app) !== 'Akorith Next.app') throw Error('--app requires the exact absolute Akorith Next.app bundle.');
    if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result.expectedVersion || '')) throw Error('--expected-version is required.');
  }
  return result;
}
function ownedCommand(command, executable, port, nonce) {
  const args = command.slice(executable.length).trim().split(/\s+/);
  return command.startsWith(executable + ' ') && args.includes(`--remote-debugging-port=${port}`) &&
    args.includes(`--akorith-e2e-nonce=${nonce}`) && !args.some(value => value.startsWith('--type='));
}
function sameIdentity(expected, current) {
  return !!expected && !!current && expected.pid === current.pid && expected.started === current.started && expected.command === current.command;
}
function probe(pid, kill = process.kill) {
  try { kill(pid, 0); return { state: 'alive' }; }
  catch (error) { return error.code === 'ESRCH' ? { state: 'absent' } : { state: 'unknown', code: error.code }; }
}
function fixtureFields(manifest, nonce, tmpRoot, earliest) {
  assert.equal(manifest.protocol, 'akorith-import-display-fixture-v1');
  assert.equal(manifest.synthetic, true); assert.equal(manifest.modelRuns, 0); assert.equal(manifest.state, 'ready');
  assert.equal(manifest.nonce, nonce); assert.match(nonce, /^[a-f0-9]{32}$/);
  assert.equal(path.dirname(manifest.root), tmpRoot); assert.match(path.basename(manifest.root), /^akorith-history-display-[a-zA-Z0-9]+$/);
  assert.equal(manifest.userData, path.join(manifest.root, 'data')); assert.equal(manifest.project, path.join(manifest.root, 'project'));
  assert.equal(manifest.sourcePath, path.join(manifest.root, 'legacy', 'loopex.db'));
  assert.ok(Date.parse(manifest.createdAt) >= earliest && Date.parse(manifest.createdAt) <= Date.now());
  assert.equal(manifest.messageCount, 6); assert.equal(manifest.expected.length, 5);
  assert.equal(new Set(manifest.expected.map(row => row.id)).size, 5);
  assert.ok(manifest.expected.every(row => /^[a-f0-9-]{36}$/.test(row.id) && row.turnId === `import:${row.legacyId}`));
}
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
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
function help() {
  console.log('node v2/tests/e2e/packaged-history-display.cjs --run --app "/exact/Akorith Next.app" --expected-version 2.0.0-alpha.4 --package-id B04\n' +
    'Always seeds fresh disposable data through real importLegacy; never accepts old fixtures or real history.\n' +
    'No model submission or Import button. Receipt rendering has separate SSR coverage; screenshots cover persisted transcript only.\n' +
    '--self-test checks pure ownership/argument guards without files, native processes, models, or GUI.');
}

async function main(args = process.argv.slice(2)) {
  const config = options(args);
  if (!config.run) { help(); return; }
  if (process.platform !== 'darwin') throw Error('LaunchServices acceptance requires macOS.');
  config.app = fs.realpathSync(config.app);
  assert.equal(path.basename(config.app), 'Akorith Next.app');
  const executable = path.join(config.app, 'Contents', 'MacOS', 'Akorith Next');
  const asar = path.join(config.app, 'Contents', 'Resources', 'app.asar');
  const plistVersion = cp.execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(config.app, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim();
  assert.equal(plistVersion, config.expectedVersion, 'Bundle version must match before fixture creation or launch');
  const appSha256 = hash(asar), nonce = crypto.randomBytes(16).toString('hex'), earliest = Date.now();
  const repo = path.resolve(__dirname, '../../..');
  const seed = path.join(__dirname, 'seed-import-display.ts');
  const electron = require('electron');
  const seeded = JSON.parse(cp.execFileSync(electron, ['--import', 'tsx', seed, '--create', '--nonce', nonce], {
    cwd: repo, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', TSX_TSCONFIG_PATH: path.join(repo, 'tsconfig.v2.json') },
  }).trim());
  assert.equal(seeded.nonce, nonce);
  assert.equal(seeded.markerPath, path.join(seeded.root, 'fixture.json'));
  const fixture = JSON.parse(fs.readFileSync(seeded.markerPath, 'utf8'));
  fixtureFields(fixture, nonce, fs.realpathSync(os.tmpdir()), earliest);
  assert.equal(fixture.root, seeded.root);
  for (const entry of [fixture.root, fixture.userData, fixture.project, fixture.sourcePath, seeded.markerPath]) assert.equal(fs.realpathSync(entry), entry, 'Fixture paths must not be symlink aliases');
  assert.equal(hash(fixture.sourcePath), fixture.sourceSha256);
  assert.equal(hash(path.join(fixture.userData, 'workspace.sqlite')), fixture.targetSha256);
  // A fresh nonce and exclusive claim prohibit reuse even if this script is adapted later.
  fs.writeFileSync(path.join(fixture.root, 'launch-claim.json'), JSON.stringify({ nonce, claimedAt: new Date().toISOString() }) + '\n', { flag: 'wx' });
  const reportPath = path.join(fixture.root, 'history-display.json');
  const report = {
    protocol, ...config, nonce, fixture: seeded.markerPath, root: fixture.root, userData: fixture.userData,
    synthetic: true, modelSubmissions: 0, startedAt: new Date().toISOString(),
    package: { version: plistVersion, asarSha256: appSha256 }, harnessSha256: hash(__filename),
    importProvenance: { method: 'Offline source importLegacy into fresh Store; packaged renderer reads its real persisted messages.', seedSourceSha256: fixture.seedSourceSha256, migrationSourceSha256: fixture.migrationSourceSha256, storageSourceSha256: fixture.storageSourceSha256 },
    receiptUi: { status: 'not-run', reason: 'No fixture injection or default-source Import button. Separate importReceipt SSR tests cover receipt rendering.', savedReceipt: fixture.receipt },
    checks: [], screenshots: [], errors: [], cleanup: [], completed: false,
  };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const record = (name, data = {}) => { const result = { name, at: new Date().toISOString(), ...data }; report.checks.push(result); save(); console.log(JSON.stringify(result)); };
  const command = (file, args) => cp.execFileSync(file, args, { cwd: fixture.project, encoding: 'utf8', timeout: 5000, maxBuffer: 2 * 1024 * 1024 });
  const identity = pid => {
    const state = probe(pid);
    if (state.state === 'absent') return null;
    if (state.state === 'unknown') return { pid, unknown: state };
    try {
      const started = command('/bin/ps', ['-p', String(pid), '-o', 'lstart=']).trim();
      const text = command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command=']).trim();
      const ppid = Number(command('/bin/ps', ['-p', String(pid), '-o', 'ppid=']).trim());
      if (!started || !text || !Number.isSafeInteger(ppid)) throw Error('Incomplete PID identity');
      return { pid, started, command: text, ppid };
    } catch (error) { if (probe(pid).state === 'absent') return null; throw error; }
  };
  const owners = new Map();
  let owner, browser, page, port, attempted = false;
  const invoke = async (name, payload) => {
    let timer;
    try {
      return await Promise.race([
        page.evaluate(({ name, payload }) => window.akorith.invoke(name, payload), { name, payload }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`IPC ${name} timed out`)), 15000); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  function discover() {
    const matches = command('/bin/ps', ['-ww', '-axo', 'pid=,command=']).split('\n').flatMap(line => {
      const row = line.trim().match(/^(\d+)\s+(.*)$/);
      return row && ownedCommand(row[2], executable, port, nonce) ? [Number(row[1])] : [];
    });
    if (matches.length > 1) throw Error('Multiple owned-main candidates; no PID guessed.');
    if (!matches.length) return null;
    const current = identity(matches[0]);
    return current && !current.unknown && ownedCommand(current.command, executable, port, nonce) ? current : null;
  }
  function rememberDescendants() {
    if (!owner || !sameIdentity(owner, identity(owner.pid))) return;
    const rows = command('/bin/ps', ['-axo', 'pid=,ppid=']).trim().split('\n').map(row => row.trim().split(/\s+/).map(Number));
    const ids = new Set([owner.pid]);
    for (let pass = 0; pass < 40; pass++) { const size = ids.size; for (const [pid, ppid] of rows) if (ids.has(ppid)) ids.add(pid); if (ids.size === size) break; }
    for (const pid of ids) {
      if (pid === owner.pid || owners.has(pid)) continue;
      const current = identity(pid);
      if (!current) continue;
      if (current.unknown) {
        report.errors.push({ phase: 'descendant-ownership', pid, error: 'A candidate descendant has unknown process identity; no signal is authorized for it.' });
        continue;
      }
      let ancestor = current;
      for (let depth = 0; ancestor && !ancestor.unknown && ancestor.pid !== owner.pid && depth < 40; depth++) ancestor = ancestor.ppid > 1 ? identity(ancestor.ppid) : null;
      if (sameIdentity(owner, ancestor)) owners.set(pid, current);
      else if (ancestor?.unknown) report.errors.push({ phase: 'descendant-ownership', pid, error: 'Candidate ancestry could not be confirmed because a process probe was unknown; no signal is authorized.' });
    }
  }
  async function cleanupOwned(expected, label) {
    const start = Date.now(), receipt = { label, pid: expected.pid, normalQuit: false, signals: [], observations: [], absent: false, forced: false };
    report.cleanup.push(receipt); save();
    const observe = async timeout => {
      try {
        await until(() => {
          const state = probe(expected.pid), previous = receipt.observations.at(-1);
          if (!previous || state.state !== previous.state || state.code !== previous.code) receipt.observations.push({ ...state, elapsedMs: Date.now() - start });
          if (state.state === 'absent') { receipt.absent = true; return true; }
          return false;
        }, `${label} actual ESRCH`, timeout);
      } catch { /* Retain alive/unknown for exact-identity cleanup or failure. */ }
    };
    try {
      await observe(2000);
      if (receipt.absent) return;
      let current = identity(expected.pid);
      if (!current) { await observe(5000); return; }
      if (current.unknown) { await observe(5000); if (receipt.absent) return; current = identity(expected.pid); }
      assert.ok(sameIdentity(expected, current), `${label} cleanup ownership is unknown or changed; no signal sent`);
      process.kill(expected.pid, 'SIGTERM'); receipt.signals.push('SIGTERM'); save();
      await observe(20000);
      if (!receipt.absent) {
        current = identity(expected.pid);
        assert.ok(sameIdentity(expected, current), `${label} ownership changed before recovery KILL`);
        process.kill(expected.pid, 'SIGKILL'); receipt.signals.push('SIGKILL'); receipt.forced = true; save();
        await observe(5000);
      }
      assert.equal(receipt.absent, true, `${label} did not confirm absence`);
    } catch (error) { receipt.error = errorText(error); report.errors.push({ phase: 'cleanup', error: receipt.error }); }
    finally { receipt.elapsedMs = Date.now() - start; save(); }
  }
  try {
    save(); port = await unusedPort(); report.port = port;
    const log = path.join(fixture.root, 'launch.log'); report.log = log; attempted = true; save();
    command('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${fixture.userData}`, '--stdout', log, '--stderr', log, '-a', config.app, '--args', `--remote-debugging-port=${port}`, `--akorith-e2e-nonce=${nonce}`]);
    owner = await until(discover, 'exact owned app PID with nonce', 15000); report.owner = owner; save();
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }, 'packaged CDP', 30000);
    const { chromium } = require('playwright-core');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html'));
    assert.ok(page); page.setDefaultTimeout(10000);
    page.on('pageerror', error => { report.errors.push({ phase: 'renderer', error: errorText(error) }); save(); });
    await page.locator('#prompt-input').waitFor();
    let stable = 0;
    const snapshot = await until(async () => {
      const [snapshot, diagnostics] = await Promise.all([invoke('app:snapshot'), invoke('app:diagnostics')]);
      assert.equal(snapshot.version, config.expectedVersion);
      stable = snapshot.providers.every(row => row.connectionLabel !== 'Checking') && diagnostics.providerRefreshPending === false ? stable + 1 : 0;
      return stable >= 2 ? snapshot : false;
    }, 'settled native provider discovery; no model submits', 45000);
    assert.deepEqual(snapshot.tasks.map(task => task.id), [fixture.taskId], 'Launched app must open this sole synthetic task');
    record('Owned package ready', { pid: owner.pid, version: snapshot.version, providers: snapshot.providers.map(({ id, available, authenticated, connectionLabel }) => ({ id, available, authenticated, connectionLabel })) });
    await page.locator('.task-select').filter({ hasText: fixture.taskTitle }).click();
    await page.locator(`article[data-message-id="${fixture.expected[0].id}"]`).waitFor();
    assert.equal(await page.locator('article.message').count(), 6);
    const before = await invoke('task:read', { taskId: fixture.taskId });
    assert.equal(before.pending.length, 0); assert.deepEqual(before.task.nativeSessions, {});
    assert.equal(before.task.providerId, fixture.taskProvider); assert.equal(before.task.model, fixture.taskModel);
    for (const expected of fixture.expected) {
      const persisted = before.messages.find(message => message.id === expected.id);
      assert.equal(persisted?.status, expected.status);
      const article = page.locator(`article[data-message-id="${expected.id}"]`);
      assert.equal((await article.locator('.message-attribution').innerText()).trim(), expected.attribution);
      assert.equal(await article.locator('.message-attribution').getAttribute('title'), expected.attribution);
      assert.equal(await article.locator('.spinner, .live-state').count(), 0, 'Imported turns are inactive');
      for (const [title, status] of expected.activities) {
        const activity = article.locator('.activity').filter({ hasText: title });
        assert.equal(await activity.count(), 1);
        assert.ok((await activity.getAttribute('class')).split(/\s+/).includes(status));
        if (status === 'unknown' || status === 'interrupted') {
          assert.equal((await activity.locator('.activity-unverified').innerText()).trim(), 'Outcome not recorded');
          assert.equal(await activity.locator('.spinner, .lucide-check').count(), 0, 'Unverified activities cannot appear running or successful');
          assert.equal(await activity.locator('.lucide-circle-alert').count(), 1);
        }
      }
      if (expected.outcome) assert.equal((await article.locator('.turn-outcome').innerText()).trim(), expected.outcome);
      else assert.equal(await article.locator('.turn-outcome').count(), 0);
      if (expected.goal) assert.equal((await article.getByLabel('Imported goal status').innerText()).trim(), expected.goal);
      assert.equal(await invoke('checkpoints:list', { taskId: fixture.taskId, turnId: expected.turnId }), null);
      assert.equal(await article.getByRole('button', { name: /Undo|Review .*changed files/i }).count(), 0);
    }
    record('Persisted imported statuses, independent child outcomes, attribution and inactive checkpoints', { messages: 6, assistants: 5 });
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex');
    await until(async () => (await invoke('task:read', { taskId: fixture.taskId })).task.providerId === 'codex', 'UI current provider switch persisted');
    const after = await invoke('task:read', { taskId: fixture.taskId });
    assert.deepEqual(after.messages, before.messages, 'Provider selection cannot mutate imported messages');
    for (const expected of fixture.expected) assert.equal((await page.locator(`article[data-message-id="${expected.id}"] .message-attribution`).innerText()).trim(), expected.attribution);
    record('Current provider changed through UI while every historical provider/model label stayed unchanged', { from: fixture.taskProvider, to: 'codex' });
    for (const width of [1390, 950]) {
      // Electron does not expose Browser.getWindowForTarget. This changes only
      // the owned renderer's emulated viewport, never the physical macOS window.
      await page.setViewportSize({ width, height: 1000 });
      await until(async () => Math.abs((await page.evaluate(() => window.innerWidth)) - width) <= 2, `renderer-emulated viewport ${width}`);
      for (const theme of ['light', 'dark']) {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        const settings = page.getByRole('dialog', { name: 'Settings', exact: true });
        await settings.getByRole('button', { name: theme === 'light' ? 'Light' : 'Dark', exact: true }).click();
        await until(async () => (await invoke('app:snapshot')).settings.theme === theme && await page.evaluate(theme => document.documentElement.dataset.theme === theme, theme), `theme ${theme} applied`);
        await settings.getByRole('button', { name: 'Close', exact: true }).click();
        const layout = await page.evaluate(() => {
          const measure = element => { const rect = element.getBoundingClientRect(); return { className: element.className, messageId: element.closest('article')?.dataset.messageId, left: rect.left, right: rect.right, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }; };
          return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, elements: [...document.querySelectorAll('.message-footer,.message-attribution,.turn-outcome,.imported-goal,.transcript-scroll')].map(measure) };
        });
        assert.ok(layout.documentWidth <= layout.width + 2, 'Document must not horizontally overflow');
        for (const item of layout.elements) {
          assert.ok(item.left >= -2 && item.right <= layout.width + 2, `Element escaped viewport: ${JSON.stringify(item)}`);
          assert.ok(item.scrollWidth <= item.clientWidth + 2, `Footer/provenance horizontal overflow: ${JSON.stringify(item)}`);
        }
        record('Theme and renderer-emulated viewport layout', { theme, requestedWidth: width, physicalWindowResized: false, method: 'Playwright page.setViewportSize / renderer emulation', layout });
        for (const position of ['top', 'bottom']) {
          await page.locator('.transcript-scroll').evaluate((element, position) => element.scrollTo({ top: position === 'top' ? 0 : element.scrollHeight, behavior: 'instant' }), position);
          const screenshot = path.join(fixture.root, `history-${theme}-${width}-${position}.png`);
          await page.screenshot({ path: screenshot }); report.screenshots.push(screenshot); save();
        }
      }
    }
    const diagnostics = await invoke('app:diagnostics');
    assert.equal(diagnostics.engine.active.length, 0); assert.equal(diagnostics.engine.writerLeases, 0);
    assert.deepEqual((await invoke('task:read', { taskId: fixture.taskId })).messages, before.messages);
    assert.equal(hash(fixture.sourcePath), fixture.sourceSha256);
    record('No model execution, history mutation or active writer lease', { diagnostics, sourceUnchanged: true });
    report.acceptancePassed = true;
  } catch (error) {
    report.errors.push({ phase: 'acceptance', error: errorText(error) });
    if (page) try { const screenshot = path.join(fixture.root, 'failure.png'); await page.screenshot({ path: screenshot, timeout: 5000 }); report.screenshots.push(screenshot); } catch (captureError) { report.errors.push({ phase: 'failure-screenshot', error: errorText(captureError) }); }
  } finally {
    if (!owner && attempted) try { owner = discover(); if (owner) report.owner = owner; } catch (error) { report.errors.push({ phase: 'recover-ownership', error: errorText(error) }); }
    if (owner) {
      try { rememberDescendants(); } catch (error) { report.errors.push({ phase: 'descendant-ownership', error: errorText(error) }); }
      await cleanupOwned(owner, 'owned main');
      await Promise.all([...owners.values()].map(child => cleanupOwned(child, 'verified owned descendant')));
    } else if (attempted) report.errors.push({ phase: 'cleanup', error: 'Launch was attempted but exact owned main identity could not be established. No unrelated process was signalled.' });
    try { await browser?.close(); } catch (error) { report.errors.push({ phase: 'CDP disconnect', error: errorText(error) }); }
    report.completed = report.acceptancePassed === true && report.errors.length === 0 && report.cleanup.length > 0 && report.cleanup.every(row => row.absent && !row.forced);
    report.finishedAt = new Date().toISOString(); save();
    console.log(JSON.stringify({ completed: report.completed, reportPath, modelSubmissions: report.modelSubmissions, receiptUi: 'not-run' }));
    if (!report.completed) process.exitCode = 1;
  }
}

function selfTest() {
  assert.throws(() => options(['--run']), /--app/);
  assert.throws(() => options(['--run', '--app', '/tmp/Akorith Next.app']), /expected-version/);
  for (const flag of ['--user-data', '--source', '--fixture', '--continue-report']) assert.throws(() => options([flag, '/existing']), /Unknown option/);
  assert.throws(() => options(['--run', '--run']), /Repeated option/);
  const executable = '/tmp/Owned app/Akorith Next.app/Contents/MacOS/Akorith Next', nonce = 'a'.repeat(32), command = `${executable} --remote-debugging-port=1234 --akorith-e2e-nonce=${nonce}`;
  assert.equal(ownedCommand(command, executable, 1234, nonce), true);
  assert.equal(ownedCommand(command + ' --type=renderer', executable, 1234, nonce), false);
  assert.equal(ownedCommand('/unrelated ' + command, executable, 1234, nonce), false);
  assert.equal(ownedCommand(command, executable, 123, nonce), false);
  assert.equal(ownedCommand(command, executable, 1234, 'b'.repeat(32)), false);
  assert.deepEqual(probe(7, () => { throw Object.assign(Error(), { code: 'EPERM' }); }), { state: 'unknown', code: 'EPERM' });
  assert.deepEqual(probe(7, () => { throw Object.assign(Error(), { code: 'ESRCH' }); }), { state: 'absent' });
  assert.equal(sameIdentity({ pid: 7, started: 'old', command }, { pid: 7, started: 'new', command }), false);
  const fixture = { protocol: 'akorith-import-display-fixture-v1', synthetic: true, modelRuns: 0, state: 'ready', nonce, root: '/tmp/akorith-history-display-abcdef', userData: '/tmp/akorith-history-display-abcdef/data', project: '/tmp/akorith-history-display-abcdef/project', sourcePath: '/tmp/akorith-history-display-abcdef/legacy/loopex.db', createdAt: new Date().toISOString(), messageCount: 6, expected: Array.from({ length: 5 }, (_, index) => ({ id: `00000000-0000-0000-0000-${String(index).padStart(12, '0')}`, legacyId: `m${index}`, turnId: `import:m${index}` })) };
  fixtureFields(fixture, nonce, '/tmp', Date.now() - 1000);
  assert.throws(() => fixtureFields({ ...fixture, userData: '/existing' }, nonce, '/tmp', 0));
  assert.throws(() => fixtureFields({ ...fixture, synthetic: false }, nonce, '/tmp', 0));
  assert.throws(() => fixtureFields(fixture, 'b'.repeat(32), '/tmp', 0));
  console.log('Pure history-display argument, fixture and PID guards passed. No fixture, native process, provider, model, or GUI launched.');
}

if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
else main().catch(error => { console.error(errorText(error)); process.exitCode = 1; });
