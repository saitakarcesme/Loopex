import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { inspectGate, sourceDigest } from './acceptance-gate.mjs'
test('delivery requires actual evidence and invalidates after source changes', () => {
 const root=mkdtempSync(join(tmpdir(),'akorith-acceptance-test-'))
 try {
  mkdirSync(join(root,'v2'));mkdirSync(join(root,'docs/ui-parity'),{recursive:true})
  const evidence=join(root,'shot.txt');writeFileSync(evidence,'test evidence fixture')
  const item={id:'UI-1',requirement:'test',status:'pending',evidence:[]}
  const save=()=>writeFileSync(join(root,'docs/ui-parity/acceptance.json'),JSON.stringify({items:[item]}))
  save();assert.equal(inspectGate(root).pass,false)
  item.status='verified';item.sourceDigest=sourceDigest(root);save();assert.equal(inspectGate(root).pass,false)
  item.evidence=[{path:evidence,sha256:createHash('sha256').update('test evidence fixture').digest('hex')}];save();assert.equal(inspectGate(root).pass,true)
  writeFileSync(join(root,'v2/changed.ts'),'source change');assert.equal(inspectGate(root).pass,false)
 } finally {rmSync(root,{recursive:true,force:true})}
})
