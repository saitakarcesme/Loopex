import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, symlink, link, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchProjectFiles, attachProjectFile, mentionPathAllowed } from '../main/project-files'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'akorith-file-mention-')), project=join(root,'project'), data=join(root,'data')
  await mkdir(join(project,'src'),{recursive:true}); await mkdir(join(project,'.private')); await mkdir(join(project,'node_modules'))
  await writeFile(join(project,'src','app.ts'),'export const answer = 42;')
  await writeFile(join(project,'.env'),'SYNTHETIC_ONLY'); await writeFile(join(project,'.private','hidden.txt'),'SYNTHETIC_ONLY')
  await writeFile(join(project,'credentials.json'),'SYNTHETIC_ONLY'); await writeFile(join(project,'id_rsa'),'SYNTHETIC_ONLY')
  await writeFile(join(project,'node_modules','dependency.js'),'dependency')
  await writeFile(join(root,'outside.txt'),'OUTSIDE_SYNTHETIC_ONLY')
  await symlink(join(root,'outside.txt'),join(project,'alias.txt'))
  await link(join(root,'outside.txt'),join(project,'hardlink.txt'))
  return {root,project,data}
}
test('mention search lists project files only, excluding hidden credentials, dependency trees and links', async()=>{
  const f=await fixture()
  assert.deepEqual(await searchProjectFiles(f.project,''),[{path:'src/app.ts',name:'app.ts'}])
  assert.deepEqual(await searchProjectFiles(f.project,'APP'),[{path:'src/app.ts',name:'app.ts'}])
  assert.deepEqual(await searchProjectFiles(f.project,'missing'),[])
  await assert.rejects(searchProjectFiles(f.project,'../outside'),/Invalid/)
})
test('mention selection copies a validated snapshot into existing managed attachment storage',async()=>{
  const f=await fixture(), file=await attachProjectFile(f.project,'src/app.ts',f.data,'task-fixture')
  assert.equal(file.name,'app.ts'); assert.equal(file.size,25)
  assert.equal(await readFile(file.path,'utf8'),'export const answer = 42;')
  assert.ok(file.path.startsWith(join(f.data,'attachments','task-fixture')))
  await writeFile(join(f.project,'src','app.ts'),'changed')
  assert.equal(await readFile(file.path,'utf8'),'export const answer = 42;')
  for(const path of ['../outside.txt','.env','.private/hidden.txt','credentials.json','id_rsa','alias.txt','hardlink.txt']) await assert.rejects(attachProjectFile(f.project,path,f.data,'task-fixture'))
  assert.equal((await readdir(join(f.data,'attachments','task-fixture'))).length,1)
})
test('search is bounded to twenty results and traversal syntax is rejected',async()=>{
  const f=await fixture()
  await Promise.all(Array.from({length:30},(_,i)=>writeFile(join(f.project,`file-${i}.txt`),'fixture')))
  assert.equal((await searchProjectFiles(f.project,'file-')).length,20)
  for(const path of ['/etc/passwd','src/../app.ts','a\\b','src//app.ts','src/private.key','src/token.json']) assert.equal(mentionPathAllowed(path),false)
})
