/** Small synthetic SQLite fixtures only. Electron is used in Node mode, never GUI. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const { once } = require('node:events');
const { fixtureCounts } = require('./performance-v3.cjs');
const electron = require('electron');
const sqliteModule = require.resolve('better-sqlite3');
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
const create = `
  const Database = require(process.argv[1]);
  const db = new Database(process.argv[2]);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE tasks (value INTEGER); CREATE TABLE messages (value INTEGER); CREATE TABLE turns (value INTEGER); INSERT INTO tasks VALUES (1),(2); INSERT INTO messages VALUES (1),(2),(3); INSERT INTO turns VALUES (1);');
  if (process.argv[3] === 'hold') {
    process.stdin.once('data', () => { db.close(); process.exit(0); });
    process.stdout.write('READY\\n');
  } else { db.close(); }
`;
const directory = () => fs.mkdtempSync(path.join(os.tmpdir(), 'akorith-perf-preflight-test-'));

test('fresh closed WAL fixture is counted with matching Electron ABI and actual readonly connection', () => {
  const data = directory();
  cp.execFileSync(electron, ['-e', create, sqliteModule, path.join(data, 'workspace.sqlite'), 'close'], { env, timeout: 10000 });
  assert.equal(fs.existsSync(path.join(data, 'workspace.sqlite-wal')), false);
  let provenance;
  assert.deepEqual(fixtureCounts(data, value => { provenance = value; }), { tasks: 2, messages: 3, turns: 1 });
  assert.match(provenance.electron, /^44\./);
  assert.equal(provenance.readonly, true);
  assert.equal(provenance.fileMustExist, true);
  assert.equal(provenance.immutable, false);
  assert.equal(provenance.databasePath, fs.realpathSync(path.join(data, 'workspace.sqlite')));
});

test('reader sees committed rows still in a live WAL, then reads after writer closes', { timeout: 20000 }, async () => {
  const data = directory(), file = path.join(data, 'workspace.sqlite');
  const child = cp.spawn(electron, ['-e', create, sqliteModule, file, 'hold'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  let stderr = ''; child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      let text = '';
      const timer = setTimeout(() => reject(new Error(`Synthetic writer did not become ready: ${stderr}`)), 10000);
      child.stdout.on('data', chunk => { text += chunk; if (text.includes('READY')) { clearTimeout(timer); resolve(); } });
      child.once('error', error => { clearTimeout(timer); reject(error); });
    });
    assert.ok(fs.statSync(`${file}-wal`).size > 0, 'Rows must still be present in an active WAL.');
    assert.deepEqual(fixtureCounts(data), { tasks: 2, messages: 3, turns: 1 });
    child.stdin.end('close\n');
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr); assert.equal(signal, null);
    assert.deepEqual(fixtureCounts(data), { tasks: 2, messages: 3, turns: 1 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
  }
});

test('missing database is never created by the read-only count helper', () => {
  const data = directory();
  assert.throws(() => fixtureCounts(data), /ENOENT/);
  assert.equal(fs.existsSync(path.join(data, 'workspace.sqlite')), false);
});

test('count mismatch is durably reported as preflight failure with no app launch', () => {
  const data = directory(), output = directory();
  cp.execFileSync(electron, ['-e', create, sqliteModule, path.join(data, 'workspace.sqlite'), 'close'], { env, timeout: 10000 });
  fs.writeFileSync(path.join(data, 'synthetic-performance.json'), JSON.stringify({ synthetic: true, modelRuns: 0, userData: data, taskCount: 1000, messageCount: 10000, heavyMessageCount: 1000, heavyTaskId: 'a', switchTaskIds: ['a','b','c','d'] }));
  // A non-executable placeholder only satisfies path validation. The mismatch
  // must fail before package hashing, LaunchServices, CDP, or any model call.
  const app = path.join(directory(), 'Never launched.app');
  fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
  fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'Akorith Next'), 'synthetic placeholder; never executable');
  const run = cp.spawnSync(process.execPath, [path.join(__dirname, 'performance-v3.cjs'), '--run', '--app', app, '--user-data', data, '--output', output], { encoding: 'utf8', timeout: 20000 });
  assert.equal(run.status, 1, run.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(output, 'performance.json'), 'utf8'));
  assert.equal(report.failureStage, 'preflight');
  assert.match(report.failure, /Actual synthetic database counts do not match/);
  assert.deepEqual(report.verifiedCountsBefore, { tasks: 2, messages: 3, turns: 1 });
  assert.equal(report.completed, false); assert.equal(report.successful, false);
  assert.equal(report.cleanup.notLaunched, true); assert.equal(report.modelRuns, 0);
  assert.equal(report.pid, undefined); assert.equal(report.launchReadyMs, undefined);
  assert.equal(fs.existsSync(path.join(output, 'launch.log')), false);
});
