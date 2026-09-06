import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, realpath, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store } from '../main/storage';
import { createProjectFolder } from '../main/project-creation';
import { projectFolderName } from '../main/project-names';

async function fixture(t: { after(callback: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'akorith-project-'));
  const parent = join(root, 'parent'); await mkdir(parent);
  const database = join(root, 'workspace.sqlite');
  let store = new Store(database);
  t.after(async () => { if (store.db.open) store.close(); await rm(root, { recursive: true, force: true }); });
  return { root, parent, get store() { return store; }, reopen() { store.close(); store = new Store(database); return store; } };
}
test('new project creates one empty named directory and persists with existing parent files preserved', async t => {
  const f = await fixture(t); await writeFile(join(f.parent, 'keep.txt'), 'original');
  const project = createProjectFolder(f.store, f.parent, 'Türkçe Project');
  assert.equal(project.path, join(await realpath(f.parent), 'Türkçe Project'));
  assert.deepEqual(await readdir(project.path), []);
  assert.equal(await readFile(join(f.parent, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(f.reopen().project(project.id), project);
});
test('folder name validation rejects traversal, hidden/reserved names and invalid byte lengths before mutation', async t => {
  const f = await fixture(t);
  for (const name of ['', '.', '..', '../escape', '/tmp/escape', 'a/b', 'a\\b', 'a:b', '.hidden', ' trailing ', 'trailing.', 'nul', 'CON.txt', 'bad\0name', '😀'.repeat(100), 5, null]) {
    assert.throws(() => createProjectFolder(f.store, f.parent, name));
  }
  assert.deepEqual(await readdir(f.parent), []);
  assert.deepEqual(f.store.projects(), []);
  assert.equal(projectFolderName('valid name-2026'), 'valid name-2026');
});
test('existing file, directory and symlink cannot be overwritten or adopted by create', async t => {
  const f = await fixture(t); await mkdir(join(f.parent, 'existing'));
  await writeFile(join(f.parent, 'existing', 'keep'), 'original');
  await writeFile(join(f.parent, 'file'), 'original file');
  await symlink(join(f.parent, 'existing'), join(f.parent, 'alias'));
  for (const name of ['existing', 'file', 'alias']) assert.throws(() => createProjectFolder(f.store, f.parent, name), /already exists/);
  assert.equal(await readFile(join(f.parent, 'existing', 'keep'), 'utf8'), 'original');
  assert.equal(await readFile(join(f.parent, 'file'), 'utf8'), 'original file');
  assert.deepEqual(f.store.projects(), []);
});
test('metadata rename preserves folder, project identity, tasks and creation time across restart', async t => {
  const f = await fixture(t), project = createProjectFolder(f.store, f.parent, 'source');
  const task = f.store.createTask({ projectId: project.id, providerId: 'codex', model: 'fixture' });
  await writeFile(join(project.path, 'keep.txt'), 'original');
  const renamed = f.store.renameProject(project.id, '  Human project name  ');
  assert.deepEqual(renamed, { ...project, name: 'Human project name' });
  assert.equal(await readFile(join(project.path, 'keep.txt'), 'utf8'), 'original');
  assert.deepEqual(await readdir(f.parent), ['source']);
  assert.deepEqual(f.reopen().project(project.id), renamed);
  assert.deepEqual(f.store.task(task.id), task);
  for (const name of ['', ' ', 'bad\nname', 'x'.repeat(201), {}]) assert.throws(() => f.store.renameProject(project.id, name));
  assert.throws(() => f.store.renameProject('missing', 'valid'), /not found/);
  assert.deepEqual(f.store.project(project.id), renamed);
});
test('a registered missing folder cannot be silently recreated or renamed by create', async t => {
  const f = await fixture(t), path = join(await realpath(f.parent), 'missing');
  const existing = f.store.addProject(path, 'Existing display name');
  assert.throws(() => createProjectFolder(f.store, f.parent, 'missing'), /already registered/);
  assert.deepEqual(await readdir(f.parent), []); assert.deepEqual(f.store.project(existing.id), existing);
});
test('database registration failure retains the new empty directory for explicit recovery', async t => {
  const f = await fixture(t);
  const failing = { projects: () => [], addProject: () => { throw new Error('fixture storage failure'); } } as unknown as Store;
  assert.throws(() => createProjectFolder(failing, f.parent, 'recoverable'), /Open that folder to recover/);
  assert.deepEqual(await readdir(join(f.parent, 'recoverable')), []);
});
