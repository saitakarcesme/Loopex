import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../main/storage';

test('internal project origin persists while ordinary project and task lookup remain unchanged', async t => {
  const root = await mkdtemp(join(tmpdir(), 'akorith-project-origin-')), path = join(root, 'store.sqlite');
  let store = new Store(path);
  t.after(async () => { if (store.db.open) store.close(); await rm(root, { recursive:true, force:true }); });
  const ordinary = store.addProject('/synthetic/Research 1', 'Research 1');
  const research = store.addProject('/synthetic/lab/a', 'Experiment', 10, 'research');
  const benchmark = store.addProject('/synthetic/lab/b', 'Variant', 20, 'benchmark');
  const task = store.createTask({projectId:research.id, title:'Open through Lab'});
  store.close();store = new Store(path);
  assert.equal(store.project(ordinary.id)?.origin, undefined);
  assert.equal(store.project(research.id)?.origin, 'research');
  assert.equal(store.project(benchmark.id)?.origin, 'benchmark');
  assert.equal(store.task(task.id).projectId, research.id);
  assert.equal(store.projects().length, 3, 'storage keeps all workspaces addressable');
  assert.equal(store.renameProject(research.id, 'Renamed experiment').origin, 'research');
});

test('backfill uses persisted lab ownership, not similar paths/names, and preserves source projects', async t => {
  const root=await mkdtemp(join(tmpdir(),'akorith-origin-backfill-')),path=join(root,'store.sqlite');
  let store=new Store(path);
  t.after(async()=>{if(store.db.open)store.close();await rm(root,{recursive:true,force:true});});
  const source=store.addProject('/synthetic/source','Source');
  const unrelated=store.addProject('/synthetic/research-workspaces/experiment','Research 1');
  const research=store.addProject('/synthetic/old-random-a','Old experiment');
  const benchmark=store.addProject('/synthetic/old-random-b','Old variant');
  const manual=store.addProject('/synthetic/manual-comparison','Existing user project');
  const variantTask=store.createTask({projectId:benchmark.id});
  const sourceTask=store.createTask({projectId:source.id});
  const manualTask=store.createTask({projectId:manual.id});
  store.db.exec('CREATE TABLE research_studies(data TEXT);CREATE TABLE research_experiments(data TEXT);CREATE TABLE benchmarks(data TEXT)');
  store.db.prepare('INSERT INTO research_studies VALUES (?)').run(JSON.stringify({id:'study',projectId:source.id}));
  for(const projectId of [research.id,source.id])store.db.prepare('INSERT INTO research_experiments VALUES (?)').run(JSON.stringify({studyId:'study',projectId}));
  store.db.prepare('INSERT INTO benchmarks VALUES (?)').run(JSON.stringify({projectId:source.id,variants:[{taskId:variantTask.id,execution:{workspaceIsolation:'isolated-copy'}},{taskId:sourceTask.id,execution:{workspaceIsolation:'isolated-copy'}},{taskId:manualTask.id,execution:{workspaceIsolation:'unverified'}}]}));
  store.close();store=new Store(path);
  assert.equal(store.project(research.id)?.origin,'research');
  assert.equal(store.project(benchmark.id)?.origin,'benchmark');
  for(const item of [source,unrelated,manual])assert.equal(store.project(item.id)?.origin,undefined);
  assert.equal(store.task(variantTask.id).projectId,benchmark.id);
  const first=store.projects();store.backfillProjectOrigins();assert.deepEqual(store.projects(),first);
  store.close();store=new Store(path);assert.deepEqual(store.projects(),first);
});
