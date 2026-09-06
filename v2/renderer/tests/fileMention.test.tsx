import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { fileMentionAt, insertFileMention, mentionKey, currentMentionFiles } from '../src/components/fileMentionState'
import { FileMentionMenu } from '../src/components/FileMentionMenu'

test('mention detection respects the caret and excludes email addresses and completed tokens',()=>{
  assert.deepEqual(fileMentionAt('Check @src/app',14),{start:6,end:14,query:'src/app'})
  assert.equal(fileMentionAt('user@example.com',16),null)
  assert.equal(fileMentionAt('Check @src/app ',15),null)
  const text='Check @src more'; const mention=fileMentionAt(text,10)!
  assert.deepEqual(insertFileMention(text,mention,'src/app.ts'),{text:'Check @src/app.ts  more',caret:18})
})
test('keyboard navigation wraps and Enter is consumed even while no search results are ready',()=>{
  assert.deepEqual(mentionKey('ArrowUp',3,0),{handled:true,index:2})
  assert.deepEqual(mentionKey('ArrowDown',3,2),{handled:true,index:0})
  assert.deepEqual(mentionKey('Enter',3,1),{handled:true,index:1,commit:true})
  assert.deepEqual(mentionKey('Enter',0,0),{handled:true,index:0,commit:false})
  assert.deepEqual(mentionKey('Escape',3,1),{handled:true,index:1,close:true})
  assert.equal(mentionKey('x',3,1).handled,false)
})
test('picker announces actual relative paths and active selection with listbox semantics',()=>{
  const html=renderToStaticMarkup(<FileMentionMenu files={[{path:'src/app.ts',name:'app.ts'}]} index={0} loading={false} error="" onChoose={()=>{}} />)
  assert.match(html,/role="listbox"/); assert.match(html,/role="option"/); assert.match(html,/aria-selected="true"/)
  assert.match(html,/src\/app.ts/); assert.match(html,/Enter to attach/)
})

test('Shift Enter preserves newline behavior and changed queries cannot commit old results',()=>{
  assert.deepEqual(mentionKey('Enter',3,1,{shiftKey:true}),{handled:false,index:1})
  const result={query:'src',start:6,files:[{path:'src/app.ts',name:'app.ts'}]}
  const mention={query:'other',start:6,end:12}
  assert.deepEqual(currentMentionFiles(mention,result),[])
  assert.deepEqual(mentionKey('Enter',currentMentionFiles(mention,result).length,0),{handled:true,index:0,commit:false})
  assert.deepEqual(currentMentionFiles({...mention,query:'src'},result),result.files)
  assert.deepEqual(currentMentionFiles({...mention,query:'src',start:2},result),[])
})
