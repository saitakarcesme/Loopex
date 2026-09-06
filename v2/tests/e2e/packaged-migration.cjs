#!/usr/bin/env node
/** Real history import acceptance. No launch or database access without explicit --run. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const net = require('node:net');
const PROTOCOL = 'akorith-packaged-migration-v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
function check(value, label) { if (!value) { const error = Error(label); error.acceptanceCheck = label; throw error; } }
function options(argv) {
  const result = { run: false, reopen: false, nativeQuitWindowMs: 0, packageId: 'B04' };
  const flags = { '--app': 'app', '--expected-version': 'expectedVersion', '--user-data': 'userData', '--output': 'output', '--package-id': 'packageId', '--native-quit-window-ms': 'nativeQuitWindowMs' };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]; check(!seen.has(flag), 'Duplicate command-line flag'); seen.add(flag);
    if (flag === '--run') result.run = true;
    else if (flag === '--reopen') result.reopen = true;
    else if (flags[flag]) { const value = argv[++i]; check(value && !value.startsWith('--'), 'Missing command-line value'); result[flags[flag]] = value; }
    else check(false, 'Unknown command-line flag');
  }
  if (!result.run) return result;
  check(path.isAbsolute(result.app || '') && path.basename(result.app) === 'Akorith Next.app', '--app must identify the exact absolute Akorith Next.app bundle');
  check(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(result.expectedVersion || ''), '--expected-version is required');
  check(path.isAbsolute(result.userData || ''), '--user-data is required and must be absolute');
  check(path.isAbsolute(result.output || ''), '--output is required and must be absolute');
  result.nativeQuitWindowMs = Number(result.nativeQuitWindowMs);
  check(result.nativeQuitWindowMs === 0 || (Number.isInteger(result.nativeQuitWindowMs) && result.nativeQuitWindowMs >= 10000 && result.nativeQuitWindowMs <= 180000), 'Native Quit window must be 0 or 10000–180000 ms');
  return result;
}
function inside(root, candidate) { const rel = path.relative(root, candidate); return rel === '' || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`)); }
function canonical(candidate) {
  let existing = path.resolve(candidate); const missing = [];
  while (!fs.existsSync(existing)) { const parent = path.dirname(existing); check(parent !== existing, 'Cannot resolve requested path'); missing.unshift(path.basename(existing)); existing = parent; }
  return path.join(fs.realpathSync(existing), ...missing);
}
function validatePaths(config, home = os.homedir(), real = canonical) {
  const support = path.join(home, 'Library', 'Application Support');
  const source = real(path.join(support, 'Akorith', 'loopex.db'));
  const oldRoot = real(path.join(support, 'Akorith'));
  const expectedTarget = real(path.join(support, 'Akorith Next'));
  const data = real(config.userData), app = real(config.app), output = real(config.output);
  check(data === expectedTarget, '--user-data must be the separate Akorith Next application data directory');
  check(!inside(oldRoot, data) && !inside(data, oldRoot), 'Legacy and target data directories must remain separate');
  check(!inside(oldRoot, output) && !inside(data, output) && !inside(app, output), 'Output must be outside legacy data, target data, and the app bundle');
  check(!inside(output, oldRoot) && !inside(output, data) && !inside(output, app), 'Output must not contain application or history directories');
  return { app, data, output, source, oldRoot };
}
function sourceFiles(source) {
  const result = {};
  for (const [key, suffix] of [['database', ''], ['wal', '-wal'], ['shm', '-shm']]) {
    const file = source + suffix;
    if (!fs.existsSync(file)) { result[key] = { exists: false }; continue; }
    const stat = fs.statSync(file);
    result[key] = { exists: true, size: stat.size, ...(key === 'shm' ? {} : { sha256: digest(fs.readFileSync(file)) }) };
  }
  return result;
}
function preservedFiles(before, after) {
  const database = before.database.exists && after.database.exists && before.database.sha256 === after.database.sha256;
  const wal = before.wal.exists && after.wal.exists ? before.wal.sha256 === after.wal.sha256
    : (!before.wal.exists || before.wal.size === 0) && (!after.wal.exists || after.wal.size === 0);
  return { databaseBytesUnchanged: database, walContentUnchanged: wal,
    sidecarPresenceChanged: ['wal', 'shm'].filter(key => before[key].exists !== after[key].exists),
    metadataUnchangedClaimed: false, note: 'Normal readonly SQLite WAL handling; SHM contents, filesystem timestamps and sidecar creation are not claimed unchanged.' };
}
function addedKeys(before, after) { return Object.keys(after).filter(key => !Object.hasOwn(before, key)); }
function unchangedExisting(before, after) { return Object.entries(before).every(([key, value]) => after[key] === value); }
function sameIdentity(before, after) { return !!before && !!after && before.pid === after.pid && before.started === after.started && before.command === after.command; }

// This function is serialized into an exact packaged Electron RUN_AS_NODE child.
// SQL projects only identifiers and explicit status/provider/date metadata. It
// never selects message content, activity labels/details, task titles, or settings.
function aggregateReader(sqliteModule, config) {
  const Database = require(sqliteModule), fs = require('node:fs'), crypto = require('node:crypto');
  const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const token = value => crypto.createHmac('sha256', config.nonce).update(String(value)).digest('hex');
  const read = file => new Database(file, { readonly: true, fileMustExist: true });
  const columns = (db, table) => db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name);
  const safeJson = field => `CASE WHEN json_valid(${field}) THEN ${field} ELSE '{}' END`;
  const classify = (value, known) => known.includes(value) ? value : value == null ? '(missing)' : '(unknown)';
  const group = (rows, field, known) => { const values = {}; for (const row of rows) { const key = classify(row[field], known); values[key] = (values[key] || 0) + 1; } return values; };
  const mappedProvider = id => ['chatgpt', 'codex'].includes(id) ? 'codex' : ['local', 'ollama'].includes(id) ? 'ollama' : ['claude', 'opencode'].includes(id) ? id : null;
  const expectedActivity = status => ['complete', 'completed'].includes(status) ? 'completed' : ['error', 'failed'].includes(status) ? 'failed' : ['running', 'queued', 'starting', 'waiting', 'cancelling', 'interrupted'].includes(status) ? 'interrupted' : 'unknown';
  const expectedOutcome = row => {
    if (row.role === 'user' || row.lifecycle === 'completed') return ['completed', 1];
    if (['error', 'failed', 'timed_out'].includes(row.lifecycle)) return ['failed', 1];
    if (row.lifecycle === 'cancelled') return ['cancelled', 1];
    if (row.lifecycle === 'interrupted') return ['interrupted', 1];
    if (!row.lifecycle && row.goalStatus === 'completed' && row.goalFinal === 1) return ['completed', 1];
    if (!row.lifecycle && row.goalStatus === 'error') return ['failed', 1];
    if (!row.lifecycle && row.goalStatus === 'cancelled') return ['cancelled', 1];
    return ['interrupted', 0];
  };
  const source = read(config.source);
  let target;
  try {
    const messageColumns = columns(source, 'messages');
    const sessionColumns = columns(source, 'sessions');
    if (!messageColumns.includes('provider_id') || !sessionColumns.includes('provider_id')) throw Error('Unsupported source schema');
    const metadata = messageColumns.includes('metadata') ? safeJson('metadata') : "'{}'";
    const legacyMessages = source.prepare(`SELECT id,session_id,role,provider_id,${messageColumns.includes('model') ? 'model' : 'NULL AS model'},created_at,
      json_extract(${metadata},'$.chatLifecycle.state') AS lifecycle,
      json_extract(${metadata},'$.workspaceGoal.status') AS goalStatus,json_extract(${metadata},'$.workspaceGoal.final') AS goalFinal,
      ${messageColumns.includes('attachments') ? "CASE WHEN json_valid(attachments) AND json_type(attachments)='array' THEN json_array_length(attachments) ELSE 0 END" : '0'} AS attachments
      FROM messages ORDER BY created_at,rowid`).all();
    const legacyTasks = source.prepare(`SELECT id,provider_id,created_at,updated_at,${sessionColumns.includes('pinned') ? 'pinned' : '0 AS pinned'} FROM sessions ORDER BY rowid`).all();
    const projectColumns = columns(source, 'projects');
    const legacyProjects = projectColumns.length ? source.prepare(`SELECT id,${projectColumns.includes('created_at') ? 'created_at' : 'NULL AS created_at'} FROM projects ORDER BY rowid`).all() : [];
    const legacyActivities = source.prepare(`SELECT m.id AS messageId,a.key AS position,json_extract(CASE WHEN a.type='object' THEN a.value ELSE '{}' END,'$.status') AS status,a.type
      FROM messages m,json_each(CASE WHEN json_type(${metadata},'$.activities')='array' THEN json_extract(${metadata},'$.activities') ELSE '[]' END) a ORDER BY m.rowid,a.key`).all();
    const validActivities = legacyActivities.filter(row => row.type === 'object');
    const sourceSummary = {
      counts: { projects: legacyProjects.length, tasks: legacyTasks.length, messages: legacyMessages.length, activities: legacyActivities.length, validActivities: validActivities.length, attachments: legacyMessages.reduce((sum, row) => sum + row.attachments, 0) },
      schemaSha256: hash(source.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all()),
      providerGroups: group(legacyTasks, 'provider_id', ['chatgpt', 'codex', 'claude', 'local', 'ollama', 'opencode']),
      messageProviderGroups: group(legacyMessages, 'provider_id', ['chatgpt', 'codex', 'claude', 'local', 'ollama', 'opencode']),
      lifecycleGroups: group(legacyMessages, 'lifecycle', ['running', 'completed', 'error', 'cancelled', 'timed_out', 'interrupted']),
      activityStatusGroups: group(validActivities, 'status', ['running', 'complete', 'error', 'completed', 'failed']),
      metadataSha256: hash({ legacyMessages, legacyTasks, legacyProjects, legacyActivities }),
    };
    const empty = { counts: { projects: 0, tasks: 0, messages: 0, turns: 0, events: 0, imports: 0, attachments: 0 }, activeRows: 0, scopedCounts: { projects: 0, tasks: 0, messages: 0 }, proofs: {}, private: { tasks: {}, messages: {}, projects: {}, scopedTasks: {}, scopedMessages: {}, scopedProjects: {}, nonemptyNativeSessions: [], continuationMismatches: [], taskDateMismatches: [] } };
    if (!config.target || !fs.existsSync(config.target)) return { source: sourceSummary, target: empty, runtime: { electron: process.versions.electron, modules: process.versions.modules, readonly: source.readonly, fileMustExist: true, immutable: false } };
    target = read(config.target);
    const tasks = target.prepare(`SELECT id,project_id,updated_at,json_extract(data,'$.createdAt') AS createdAt,json_extract(data,'$.providerId') AS providerId,json_extract(data,'$.model') AS model,
      json_extract(data,'$.mode') AS mode,json_extract(data,'$.status') AS status,json_extract(data,'$.pinned') AS pinned,json_extract(data,'$.archived') AS archived,
      (SELECT COUNT(*) FROM json_each(t.data,'$.nativeSessions')) AS nativeSessionCount FROM tasks t ORDER BY id`).all();
    const messages = target.prepare(`SELECT id,task_id,turn_id,created_at,json_extract(data,'$.status') AS status,
      json_extract(data,'$.attribution.providerId') AS providerId,json_extract(data,'$.attribution.originalProviderId') AS originalProviderId,json_extract(data,'$.attribution.model') AS model,
      json_extract(data,'$.importProvenance.source') AS importSource,json_extract(data,'$.importProvenance.messageId') AS originalId,
      json_extract(data,'$.importProvenance.lifecycle') AS lifecycle,json_extract(data,'$.importProvenance.outcomeRecorded') AS outcomeRecorded,
      json_extract(data,'$.importProvenance.workspaceGoal.status') AS goalStatus,json_extract(data,'$.importProvenance.workspaceGoal.final') AS goalFinal,
      COALESCE(json_array_length(data,'$.attachments'),0) AS attachments FROM messages ORDER BY id`).all();
    const projects = target.prepare("SELECT id,path,json_extract(data,'$.createdAt') AS createdAt FROM projects ORDER BY id").all();
    const allActivities = target.prepare(`SELECT m.id AS messageId,a.key AS position,json_extract(a.value,'$.status') AS status,json_extract(a.value,'$.importProvenance.originalStatus') AS originalStatus
      FROM messages m,json_each(m.data,'$.activities') a ORDER BY m.id,a.key`).all();
    const mappings = target.prepare('SELECT source,legacy_id,new_id FROM imports').all();
    const canonicalSource = fs.realpathSync(config.identitySource || config.source);
    const scoped = mappings.filter(row => { try { return fs.realpathSync(row.source) === canonicalSource; } catch { return row.source === canonicalSource; } });
    const unique = new Map(); for (const row of scoped) { const previous = unique.get(row.legacy_id); if (previous && previous !== row.new_id) throw Error('Conflicting import mappings'); unique.set(row.legacy_id, row.new_id); }
    const selected = kind => new Set([...unique.entries()].filter(([key]) => key.startsWith(kind + ':')).map(([, value]) => value));
    const scopedTaskIds = selected('task'), scopedMessageIds = selected('message'), scopedProjectIds = selected('project');
    const scopeTasks = tasks.filter(row => scopedTaskIds.has(row.id)), scopeMessages = messages.filter(row => scopedMessageIds.has(row.id)), scopeProjects = projects.filter(row => scopedProjectIds.has(row.id));
    const rowsHash = rows => Object.fromEntries(rows.map(row => [token(row.id), hash({ ...row, activities: row.task_id ? allActivities.filter(a => a.messageId === row.id) : undefined })]));
    const proofs = { matchedMessages: 0, missingSourceMessages: 0, missingTargetMappings: 0, attributionMismatches: 0, provenanceMismatches: 0, messageOutcomeMismatches: 0, messageDateMismatches: 0, activityStatusMismatches: 0, liveImportedActivities: 0,
      sourceActivityGroups: {}, targetActivityGroups: {} };
    for (const [key, id] of unique) if ((key.startsWith('task:') && !tasks.some(row => row.id === id)) || (key.startsWith('message:') && !messages.some(row => row.id === id)) || (key.startsWith('project:') && !projects.some(row => row.id === id))) proofs.missingTargetMappings++;
    const taskDateMismatches = [], continuationMismatches = [];
    for (const old of legacyTasks) {
      const current = scopeTasks.find(row => row.id === unique.get(`task:${old.id}`)); if (!current) continue;
      if (current.createdAt !== old.created_at || current.updated_at !== old.updated_at || current.pinned !== old.pinned) taskDateMismatches.push(token(current.id));
      const last = legacyMessages.filter(row => row.session_id === old.id && row.role === 'assistant' && mappedProvider(row.provider_id)).at(-1);
      if (last && (current.providerId !== mappedProvider(last.provider_id) || current.model !== (last.model || ''))) continuationMismatches.push(token(current.id));
    }
    const sourceActivityRows = [], targetActivityRows = [];
    for (const current of scopeMessages) {
      const entry = [...unique].find(([key, value]) => key.startsWith('message:') && value === current.id);
      const old = legacyMessages.find(row => `message:${row.id}` === entry?.[0]);
      if (!old) { proofs.missingSourceMessages++; continue; }
      proofs.matchedMessages++;
      if (current.originalProviderId !== old.provider_id || current.providerId !== mappedProvider(old.provider_id) || current.model !== (old.model || null)) proofs.attributionMismatches++;
      if (current.importSource !== 'akorith' || current.originalId !== old.id || current.lifecycle !== old.lifecycle || current.goalStatus !== old.goalStatus || current.goalFinal !== old.goalFinal) proofs.provenanceMismatches++;
      const [expectedStatus, recorded] = expectedOutcome(old);
      if (current.status !== expectedStatus || current.outcomeRecorded !== recorded) proofs.messageOutcomeMismatches++;
      if (current.created_at !== old.created_at) proofs.messageDateMismatches++;
      const before = validActivities.filter(row => row.messageId === old.id), after = allActivities.filter(row => row.messageId === current.id);
      if (before.length !== after.length || before.some((row, index) => after[index]?.status !== expectedActivity(row.status) || after[index]?.originalStatus !== row.status)) proofs.activityStatusMismatches++;
      proofs.liveImportedActivities += after.filter(row => ['running', 'queued', 'starting', 'waiting', 'cancelling'].includes(row.status)).length;
      sourceActivityRows.push(...before); targetActivityRows.push(...after);
    }
    proofs.sourceActivityGroups = group(sourceActivityRows, 'status', ['complete', 'error', 'running', 'completed', 'failed']);
    proofs.targetActivityGroups = group(targetActivityRows, 'status', ['completed', 'failed', 'interrupted', 'unknown']);
    proofs.targetMessageStatusGroups = group(scopeMessages, 'status', ['completed', 'failed', 'cancelled', 'interrupted']);
    const scalar = table => target.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { source: sourceSummary, target: {
      counts: { projects: projects.length, tasks: tasks.length, messages: messages.length, turns: scalar('turns'), events: scalar('events'), imports: mappings.length, attachments: messages.reduce((sum, row) => sum + row.attachments, 0) },
      activeRows: tasks.filter(row => ['running', 'queued', 'starting', 'waiting', 'cancelling'].includes(row.status)).length + target.prepare("SELECT COUNT(*) AS n FROM turns WHERE status IN ('running','queued','starting','waiting','cancelling')").get().n + allActivities.filter(row => row.status === 'running').length,
      scopedCounts: { projects: scopeProjects.length, tasks: scopeTasks.length, messages: scopeMessages.length }, proofs,
      private: { tasks: rowsHash(tasks), messages: rowsHash(messages), projects: rowsHash(projects), scopedTasks: rowsHash(scopeTasks), scopedMessages: rowsHash(scopeMessages), scopedProjects: rowsHash(scopeProjects),
        nonemptyNativeSessions: scopeTasks.filter(row => row.nativeSessionCount !== 0).map(row => token(row.id)), taskDateMismatches, continuationMismatches },
    }, runtime: { electron: process.versions.electron, modules: process.versions.modules, readonly: source.readonly && target.readonly, fileMustExist: true, immutable: false } };
  } finally { source.close(); if (target) target.close(); }
}

async function main(argv = process.argv.slice(2)) {
  const config = options(argv);
  if (!config.run) { console.log('No app or data access. See PACKAGED_MIGRATION.md. Required: --run --app /exact/Akorith\\ Next.app --expected-version VERSION --user-data /exact/Akorith\\ Next --output /new/report-directory. Optional --reopen --native-quit-window-ms 90000. --self-test only checks pure guards.'); return; }
  check(process.platform === 'darwin', 'This acceptance requires macOS');
  const paths = validatePaths(config);
  check(fs.existsSync(paths.source), 'Exact legacy database must exist');
  const executable = path.join(paths.app, 'Contents', 'MacOS', 'Akorith Next');
  check(fs.statSync(executable).isFile(), 'Exact packaged executable must exist');
  const bundleVersion = cp.execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', path.join(paths.app, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim();
  check(bundleVersion === config.expectedVersion, 'Bundle version must exactly match --expected-version');
  const bundleId = cp.execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(paths.app, 'Contents', 'Info.plist')], { encoding: 'utf8', timeout: 5000 }).trim();
  check(bundleId === 'com.akorith.workspace.v2', 'Bundle identifier must be the separate V2 application');
  fs.mkdirSync(paths.output, { recursive: true });
  const reportPath = path.join(paths.output, 'migration.json');
  fs.writeFileSync(reportPath, '', { flag: 'wx', mode: 0o600 });
  const nonce = crypto.randomBytes(16).toString('hex'), nonceArg = `--akorith-migration-proof=${nonce}`;
  const report = { protocol: PROTOCOL, packageId: config.packageId, app: paths.app, userData: paths.data, source: paths.source, expectedVersion: config.expectedVersion, bundleVersion, bundleId,
    appAsarSha256: digest(fs.readFileSync(path.join(paths.app, 'Contents', 'Resources', 'app.asar'))), harnessSha256: digest(fs.readFileSync(__filename)), nonce,
    startedAt: new Date().toISOString(), phase: 'preflight', readScope: 'Readonly SQLite identifier/status/provider/date projections and aggregates; no message content, activity label/detail, task title, or credentials are selected. DB/WAL files are hashed as bytes. Private row metadata fingerprints are not emitted.',
    submittedModelPrompts: 0, screenshots: 0, launches: [], imports: [], checks: [], pageErrorCount: 0, cleanup: [], completed: false, successful: false };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  const note = (name, value = {}) => { report.checks.push({ name, ...value, at: new Date().toISOString() }); save(); console.log(JSON.stringify({ name, ...value })); };
  const publicAggregate = result => ({ source: result.source, target: { counts: result.target.counts, activeRows: result.target.activeRows, scopedCounts: result.target.scopedCounts, proofs: result.target.proofs }, runtime: result.runtime });
  const readAggregate = (source = paths.source, target = path.join(paths.data, 'workspace.sqlite')) => {
    const code = `try { process.stdout.write(JSON.stringify((${aggregateReader.toString()})(process.argv[1], JSON.parse(process.argv[2])))); } catch { process.stdout.write(JSON.stringify({readerFailed:true})); process.exitCode=1; }`;
    let value;
    try { value = cp.execFileSync(executable, ['-e', code, require.resolve('better-sqlite3'), JSON.stringify({ source, identitySource: paths.source, target, nonce })], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, cwd: paths.output, encoding: 'utf8', timeout: 15000, maxBuffer: 16 * 1024 * 1024 }); }
    catch { check(false, 'Readonly aggregate reader failed; no raw database output retained'); }
    const result = JSON.parse(value); check(result.runtime?.readonly === true && result.runtime?.immutable === false, 'Reader must use normal readonly WAL visibility'); return result;
  };
  const snapshotFiles = () => {
    const directory = path.join(paths.data, 'backups'); if (!fs.existsSync(directory)) return [];
    check(canonical(directory) === directory, 'Target backup directory must not redirect through a symlink');
    return fs.readdirSync(directory).filter(name => /^legacy-[0-9]+-[a-f0-9]{8}\.sqlite$/.test(name)).map(name => path.join(directory, name));
  };
  const probe = pid => { try { process.kill(pid, 0); return 'alive'; } catch (error) { return error.code === 'ESRCH' ? 'absent' : 'unknown'; } };
  const identity = pid => {
    if (probe(pid) === 'absent') return null;
    try {
    const started = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 3000 }).trim();
    const command = cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 3000 }).trim();
    const parent = Number(cp.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid='], { encoding: 'utf8', timeout: 3000 }).trim());
    check(started && command && Number.isInteger(parent), 'Owned process identity must be complete'); return { pid, started, command, parent };
    } catch (error) { if (probe(pid) === 'absent') return null; throw error; }
  };
  async function until(callback, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const result = await callback(); if (result) return result; await pause(150); } check(false, label); }
  let browser, page, owner, port, launchAttempted = false, initial, first;
  const discover = () => {
    let ids; try { ids = cp.execFileSync('/usr/bin/pgrep', ['-f', nonceArg.slice(2)], { encoding: 'utf8', timeout: 3000 }).trim().split(/\s+/).filter(Boolean).map(Number); }
    catch (error) { if (error.status === 1) return null; throw error; }
    const matches = ids.flatMap(pid => { const current = identity(pid); return current && current.command.startsWith(executable + ' ') && current.command.includes(nonceArg) && current.command.includes(`--remote-debugging-port=${port}`) && !current.command.includes('--type=') ? [current] : []; });
    check(matches.length <= 1, 'More than one exact nonce-owned main process'); return matches[0] || null;
  };
  const diagnostics = async () => {
    let timer;
    const result = await Promise.race([page.evaluate(async nonce => {
      if (window.__akorithMigrationNonce !== nonce) throw Error('Ownership nonce mismatch');
      const d = await window.akorith.invoke('app:diagnostics');
      return { version: d.version, providerRefreshPending: d.providerRefreshPending, acceptedCommands: d.acceptedCommands, active: d.engine.active.length, writerLeases: d.engine.writerLeases, manualOperations: d.engine.manualOperations };
    }, nonce), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Diagnostic timeout')), 15000); })]).finally(() => clearTimeout(timer));
    check(result.version === config.expectedVersion, 'Runtime version matches requested package'); check(result.active === 0 && result.writerLeases === 0 && result.manualOperations === 0, 'No automatic provider turn or workspace writer may run during import'); return result;
  };
  async function launch() {
    port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const n = server.address().port; server.close(() => resolve(n)); }); });
    launchAttempted = true;
    cp.execFileSync('/usr/bin/open', ['-n', '--env', `AKORITH_USER_DATA=${paths.data}`, '--stdout', '/dev/null', '--stderr', '/dev/null', '-a', paths.app, '--args', '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, nonceArg], { timeout: 10000 });
    owner = await until(discover, 'Exact nonce-owned application PID was not found', 15000);
    report.launches.push({ pid: owner.pid, started: owner.started, commandSha256: digest(owner.command), port, nonce }); save();
    await until(async () => { try { return (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700) })).ok; } catch { return false; } }, 'Owned app CDP endpoint did not become ready');
    const { chromium } = require('playwright-core'); browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 15000 });
    const cdp = await browser.newBrowserCDPSession();
    const processInfo = await cdp.send('SystemInfo.getProcessInfo');
    check(processInfo.processInfo.some(info => info.type === 'browser' && Number(info.id) === owner.pid), 'CDP browser must be the exact nonce-owned main PID'); await cdp.detach();
    page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('index.html')); check(page, 'Packaged renderer must exist');
    page.setDefaultTimeout(15000); page.on('pageerror', () => { report.pageErrorCount++; save(); });
    await page.waitForFunction(() => typeof window.akorith?.invoke === 'function');
    await page.evaluate(nonce => { window.__akorithMigrationNonce = nonce; }, nonce);
    await until(async () => !(await diagnostics()).providerRefreshPending, 'Provider discovery did not settle', 45000);
    await page.keyboard.press('Meta+,');
    await page.locator('.settings-dialog').waitFor();
    await page.locator('.settings-dialog').getByRole('button', { name: 'General', exact: true }).click();
    await page.locator('.settings-dialog').getByRole('button', { name: 'Import', exact: true }).waitFor();
    note('Exact packaged Settings → General is ready', { pid: owner.pid, version: config.expectedVersion });
  }
  async function importThroughUI(index) {
    const beforeBackups = new Set(snapshotFiles());
    const button = page.locator('.settings-dialog').getByRole('button', { name: 'Import', exact: true });
    await button.click();
    const receipt = page.getByRole('region', { name: 'Import receipt', exact: true });
    await until(async () => (await receipt.count()) > 0 && await button.isEnabled(), 'Import receipt did not settle', 120000);
    const details = receipt.locator('details').filter({ has: page.locator('summary', { hasText: 'Backup and import files' }) });
    if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
    let backupPath;
    await until(async () => {
      const pathsNow = snapshotFiles().filter(file => !beforeBackups.has(file));
      if (pathsNow.length !== 1) return false;
      const displayed = (await details.locator('code').first().textContent())?.trim();
      if (displayed !== pathsNow[0]) return false;
      backupPath = pathsNow[0]; return true;
    }, 'Exactly one new owned backup must match the UI receipt', 30000);
    const copiedText = await receipt.getByLabel('Newly copied data', { exact: true }).innerText();
    const priorText = await receipt.getByLabel('Previously imported data', { exact: true }).innerText();
    const skippedText = await receipt.getByLabel('Skipped data', { exact: true }).innerText();
    const counts = (value, fields) => Object.fromEntries(fields.map(field => { const match = value.match(new RegExp(`\\b(\\d+) ${field}s?\\b`)); check(match, 'UI receipt must expose numeric copied/already-imported counts'); return [field + 's', Number(match[1])]; }));
    const copied = counts(copiedText, ['project', 'task', 'message', 'attachment']), alreadyImported = counts(priorText, ['project', 'task', 'message']);
    const skipped = {};
    for (const [key, pattern] of [['projects', /\b(\d+) projects?\b/], ['tasks', /\b(\d+) tasks?\b/], ['messages', /\b(\d+) messages?\b/], ['attachments', /\b(\d+) attachments?\b/], ['activities', /\b(\d+) activit(?:y|ies)\b/], ['metadata', /\b(\d+) metadata fields?\b/]]) skipped[key] = Number(skippedText.match(pattern)?.[1] || 0);
    const snapshot = readAggregate(backupPath);
    check(JSON.stringify(snapshot.source) === JSON.stringify(initial.source), 'Online backup aggregate and source schema/status metadata must match the pre-import source');
    const after = readAggregate();
    report.imports.push({ index, copied, alreadyImported, skipped, backupPath, backupAggregate: snapshot.source, after: publicAggregate(after) }); save();
    return { copied, alreadyImported, skipped, after };
  }
  function validateCopy(before, receipt) {
    const after = receipt.after;
    for (const field of ['projects', 'tasks', 'messages']) check(receipt.copied[field] + receipt.alreadyImported[field] + receipt.skipped[field] === initial.source.counts[field], `Every source ${field} row must be accounted for in the UI receipt`);
    check(receipt.skipped.tasks === 0 && receipt.skipped.messages === 0 && receipt.skipped.projects === 0, 'Real-history core row import must be complete; a partial receipt is retained as a failure');
    check(unchangedExisting(before.target.private.tasks, after.target.private.tasks), 'Existing target task date/provider/status metadata must remain unchanged');
    check(unchangedExisting(before.target.private.messages, after.target.private.messages), 'Existing target message attribution/date/activity metadata must remain unchanged');
    check(unchangedExisting(before.target.private.projects, after.target.private.projects), 'Existing target project metadata must remain unchanged');
    const newTasks = addedKeys(before.target.private.tasks, after.target.private.tasks), newMessages = addedKeys(before.target.private.messages, after.target.private.messages);
    check(newTasks.length === receipt.copied.tasks && after.target.counts.tasks - before.target.counts.tasks === receipt.copied.tasks, 'Copied task count must equal new target rows');
    check(newMessages.length === receipt.copied.messages && after.target.counts.messages - before.target.counts.messages === receipt.copied.messages, 'Copied message count must equal new target rows');
    check(after.target.counts.attachments - before.target.counts.attachments === receipt.copied.attachments, 'Copied attachments must equal target reference delta');
    check(after.target.scopedCounts.tasks - before.target.scopedCounts.tasks === receipt.copied.tasks && after.target.scopedCounts.messages - before.target.scopedCounts.messages === receipt.copied.messages, 'New source mappings must match copied task/message counts');
    check(after.target.scopedCounts.projects - before.target.scopedCounts.projects <= receipt.copied.projects, 'Mapped project reuse must not create extra project rows');
    check(after.target.counts.projects - before.target.counts.projects <= receipt.copied.projects, 'Project reuse may reduce the new row count');
    check(after.target.counts.turns === initial.target.counts.turns && after.target.counts.events === initial.target.counts.events, 'Import must not enqueue a model turn or old scheduler event');
    check(!after.target.private.nonemptyNativeSessions.some(key => newTasks.includes(key)), 'NEW imported tasks must have empty native sessions');
    check(!after.target.private.taskDateMismatches.some(key => newTasks.includes(key)), 'NEW imported task dates and pinned state must match legacy metadata');
    check(!after.target.private.continuationMismatches.some(key => newTasks.includes(key)), 'NEW imported continuation provider/model must be a coherent latest-known-assistant pair');
    const p = after.target.proofs;
    for (const name of ['missingSourceMessages', 'missingTargetMappings', 'attributionMismatches', 'provenanceMismatches', 'messageOutcomeMismatches', 'messageDateMismatches', 'activityStatusMismatches', 'liveImportedActivities']) check(p[name] === 0, `Imported metadata proof failed: ${name}`);
    check(p.matchedMessages === after.target.scopedCounts.messages, 'All mapped imported messages must be checked');
  }
  async function closeOwned(reason) {
    if (!owner && launchAttempted) owner = discover();
    const receipt = { reason, pid: owner?.pid, method: 'not-launched', nativeQuit: false, forced: false, confirmedAbsent: !launchAttempted, descendantPids: [], errors: [] };
    if (!owner) { if (launchAttempted) receipt.errors.push('Unique nonce-owned main process unavailable; no unscoped signal sent'); report.cleanup.push(receipt); save(); return receipt; }
    const expected = owner;
    const currentIdentity = () => { const current = identity(expected.pid); check(!current || sameIdentity(expected, current), 'Owned PID identity changed; refusing to signal'); return current; };
    const knownChildren = [];
    if (probe(expected.pid) === 'alive') {
      currentIdentity();
      const pairs = cp.execFileSync('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 3000 }).trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const ids = new Set([expected.pid]); for (let i = 0; i < 40; i++) { const size = ids.size; for (const [pid, parent] of pairs) if (ids.has(parent)) ids.add(pid); if (ids.size === size) break; }
      for (const pid of ids) if (pid !== expected.pid) { const child = identity(pid); if (child && ids.has(child.parent)) knownChildren.push(child); }
    }
    receipt.descendantPids = knownChildren.map(child => child.pid);
    const waitAbsent = async timeout => { const end = Date.now() + timeout; while (Date.now() < end) { if (probe(expected.pid) === 'absent') return true; await pause(150); } return false; };
    if (config.nativeQuitWindowMs && probe(expected.pid) !== 'absent') {
      receipt.method = 'operator-native-Quit-observation';
      note('Awaiting native Quit action on the exact owned Akorith Next window', { pid: expected.pid, windowMs: config.nativeQuitWindowMs, report: reportPath });
      receipt.nativeQuit = await waitAbsent(config.nativeQuitWindowMs);
    }
    if (receipt.nativeQuit || probe(expected.pid) === 'absent') receipt.confirmedAbsent = true;
    else {
      receipt.method = 'SIGTERM-fallback-not-native-Quit'; currentIdentity(); process.kill(expected.pid, 'SIGTERM');
      receipt.confirmedAbsent = await waitAbsent(30000);
      if (!receipt.confirmedAbsent && probe(expected.pid) === 'alive') { currentIdentity(); receipt.forced = true; process.kill(expected.pid, 'SIGKILL'); receipt.confirmedAbsent = await waitAbsent(5000); }
    }
    receipt.descendants = await Promise.all(knownChildren.map(async child => {
      const result = { pid: child.pid, confirmedAbsent: false, signals: [], forced: false, error: false };
      const wait = async ms => { const end = Date.now() + ms; while (Date.now() < end) { if (probe(child.pid) === 'absent') { result.confirmedAbsent = true; return true; } await pause(100); } return false; };
      try {
        if (await wait(5000)) return result;
        // Only the previously observed descendant identity can be signaled.
        for (const [signal, ms] of [['SIGTERM', 5000], ['SIGKILL', 2000]]) {
          const current = identity(child.pid);
          if (!current) { result.confirmedAbsent = true; break; }
          check(sameIdentity(child, current), 'Owned descendant PID identity changed; refusing to signal');
          process.kill(child.pid, signal); result.signals.push(signal);
          if (signal === 'SIGKILL') result.forced = true;
          if (await wait(ms)) break;
        }
      } catch { result.error = true; }
      return result;
    }));
    for (const child of receipt.descendants) if (!child.confirmedAbsent || child.error || child.signals.length) receipt.errors.push(`Owned descendant ${child.pid} required recovery or was not confirmed absent`);
    if (browser) { try { await Promise.race([browser.close(), pause(5000)]); } catch { receipt.errors.push('CDP disconnect failed'); } }
    browser = page = null;
    if (receipt.confirmedAbsent) { owner = null; launchAttempted = false; }
    report.cleanup.push(receipt); save(); return receipt;
  }
  try {
    save(); note('Read-only migration preflight', { report: reportPath });
    report.sourceFilesBeforeReader = sourceFiles(paths.source); initial = readAggregate(); report.before = publicAggregate(initial);
    report.sourceFilesBeforeLaunch = sourceFiles(paths.source);
    report.readerSidecarEffects = preservedFiles(report.sourceFilesBeforeReader, report.sourceFilesBeforeLaunch);
    check(report.readerSidecarEffects.databaseBytesUnchanged && report.readerSidecarEffects.walContentUnchanged, 'Readonly preflight must preserve source DB/WAL content');
    check(initial.target.activeRows === 0, 'Existing target has active/recoverable work; refusing to launch or import over it');
    await launch(); report.phase = 'first UI import';
    const firstReceipt = await importThroughUI(1); validateCopy(initial, firstReceipt); first = firstReceipt.after;
    note('First UI import and aggregate mapping proofs passed', { copied: firstReceipt.copied });
    await diagnostics(); report.phase = 'repeat UI import';
    const repeat = await importThroughUI(2); validateCopy(first, repeat);
    check(repeat.copied.tasks === 0 && repeat.copied.messages === 0 && repeat.copied.attachments === 0, 'Repeat Import must copy zero tasks/messages/attachments');
    check(JSON.stringify(first.target.counts) === JSON.stringify(repeat.after.target.counts), 'Repeat Import must preserve target row/reference counts');
    note('Repeat UI import is idempotent and preserves dates/selections');
    await diagnostics();
    const closed = await closeOwned('after real import');
    check(closed.confirmedAbsent && !closed.forced && !closed.errors.length, 'Owned application cleanup must complete without force');
    if (config.nativeQuitWindowMs) check(closed.nativeQuit, 'Requested native Quit action was not observed');
    if (config.reopen) {
      report.phase = 'roundtrip reopen'; await launch(); await diagnostics();
      const restored = readAggregate();
      check(JSON.stringify(restored.target.counts) === JSON.stringify(first.target.counts), 'Reopen must preserve first-copy counts');
      for (const field of ['tasks', 'messages', 'projects']) check(unchangedExisting(first.target.private[field], restored.target.private[field]), `Reopen must preserve ${field} date/provider/activity metadata`);
      report.reopen = publicAggregate(restored); note('Packaged roundtrip reopen preserved metadata without automatic turns');
    }
    report.completed = true;
  } catch (error) { report.failure = { phase: report.phase, check: error.acceptanceCheck || 'Operation failed; raw error omitted to protect history', kind: error.name }; save(); }
  finally {
    if (launchAttempted || owner || browser) { try { await closeOwned('final/recovery teardown'); } catch { report.cleanup.push({ confirmedAbsent: false, errors: ['Owned cleanup failed; no unscoped signal sent'] }); } }
    try {
      report.sourceFilesAfter = sourceFiles(paths.source); report.sourcePreservation = preservedFiles(report.sourceFilesBeforeReader, report.sourceFilesAfter);
      const after = readAggregate(); report.after = publicAggregate(after);
      report.sourceAggregateUnchanged = JSON.stringify(after.source) === JSON.stringify(initial?.source);
    } catch { report.sourceAggregateUnchanged = false; report.finalReadFailed = true; }
    report.cleanupComplete = report.cleanup.length > 0 && report.cleanup.every(row => row.confirmedAbsent && !row.forced && !row.errors.length);
    report.nativeQuitTest = { requested: config.nativeQuitWindowMs > 0, passed: config.nativeQuitWindowMs > 0 && report.cleanup.every(row => row.nativeQuit), fallbackIsNotNativeQuit: true };
    report.successful = report.completed && !report.failure && report.pageErrorCount === 0 && report.cleanupComplete && report.sourceAggregateUnchanged && report.sourcePreservation?.databaseBytesUnchanged && report.sourcePreservation?.walContentUnchanged && (!report.nativeQuitTest.requested || report.nativeQuitTest.passed);
    report.finishedAt = new Date().toISOString(); save(); process.exitCode = report.successful ? 0 : 1;
    console.log(JSON.stringify({ report: reportPath, successful: report.successful, completed: report.completed, sourceAggregateUnchanged: report.sourceAggregateUnchanged, cleanupComplete: report.cleanupComplete, nativeQuitTest: report.nativeQuitTest }));
  }
  return report;
}
function selfTest() {
  const args = ['--run', '--app', '/build/Akorith Next.app', '--expected-version', '2.0.0-alpha.4', '--user-data', '/home/u/Library/Application Support/Akorith Next', '--output', '/reports/migration'];
  const parsed = options(args); assert.equal(parsed.run, true);
  for (const flag of ['--app', '--expected-version', '--user-data', '--output']) { const i = args.indexOf(flag); assert.throws(() => options(args.filter((_, n) => n !== i && n !== i + 1))); }
  assert.throws(() => options([...args, '--run']));
  assert.equal(options([]).run, false);
  assert.equal(validatePaths(parsed, '/home/u', path.resolve).data, parsed.userData);
  assert.throws(() => validatePaths({ ...parsed, userData: '/home/u/Library/Application Support/Akorith' }, '/home/u', path.resolve));
  assert.throws(() => validatePaths({ ...parsed, output: parsed.userData }, '/home/u', path.resolve));
  assert.equal(unchangedExisting({ a: 'one' }, { a: 'one', b: 'two' }), true); assert.equal(unchangedExisting({ a: 'one' }, { a: 'two' }), false);
  const owned = { pid: 200, started: 'birth-1', command: '/exact/app --nonce=owned' };
  assert.equal(sameIdentity(owned, { ...owned }), true); assert.equal(sameIdentity(owned, { ...owned, started: 'birth-2' }), false); assert.equal(sameIdentity(owned, { ...owned, command: '/other/app' }), false);
  assert.deepEqual(addedKeys({ a: 'one' }, { a: 'one', b: 'two' }), ['b']);
  const initial = { database: { exists: true, sha256: 'a' }, wal: { exists: false }, shm: { exists: false } };
  const final = { database: { exists: true, sha256: 'a' }, wal: { exists: true, size: 0, sha256: 'empty' }, shm: { exists: true } };
  assert.equal(preservedFiles(initial, final).walContentUnchanged, true); assert.equal(preservedFiles(initial, final).metadataUnchangedClaimed, false);
  assert.equal(preservedFiles(initial, { ...final, database: { exists: true, sha256: 'changed' } }).databaseBytesUnchanged, false);
  console.log('Pure preflight/ownership-data guards passed; no files, databases, apps or models accessed.');
}
if (require.main === module) {
  if (process.argv.length === 3 && process.argv[2] === '--self-test') selfTest();
  else main().catch(error => { console.error(JSON.stringify({ failed: true, check: error.acceptanceCheck || 'Preflight failed; raw error omitted to protect user data' })); process.exitCode = 1; });
}
module.exports = { options, validatePaths, preservedFiles, unchangedExisting, addedKeys, sameIdentity, aggregateReader };
