const { chromium } = require('playwright-core')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

async function main() {
  const browser = await chromium.connectOverCDP(process.env.AKORITH_CDP_URL || 'http://127.0.0.1:54845')
  const page = browser.contexts()[0].pages().find(page => page.url().includes('app.asar'))
  assert.ok(page, 'The packaged application must be running through LaunchServices')
  page.setDefaultTimeout(8000)
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const snapshot = await page.evaluate(() => window.akorith.invoke('app:snapshot'))
  const original = snapshot.tasks.find(task => task.title.startsWith('Create a self-contained index.html'))
  const other = snapshot.tasks.find(task => task.draft === 'Draft in another task — keep me')
  assert.ok(original && other, 'Run the live desktop fixture before this regression')
  for (let index = 0; index < 4; index++) {
    await page.locator('.task-select').filter({ hasText: other.title }).first().click()
    await page.waitForFunction(expected => document.querySelector('#prompt-input').value === expected, other.draft)
    await page.locator('.task-select').filter({ hasText: original.title.trim() }).first().click()
    await page.waitForSelector(`article[data-task-id="${original.id}"]`)
    assert.equal(await page.locator('.transcript-region').count(), 1)
    const ids = await page.locator('article.message').evaluateAll(nodes => nodes.map(node => node.dataset.messageId))
    assert.equal(ids.length, 2); assert.equal(new Set(ids).size, 2)
  }
  const states = await page.evaluate(async () => {
    const snapshot = await window.akorith.invoke('app:snapshot')
    const computer = await window.akorith.invoke('computer:state')
    return { providers: snapshot.providers.map(provider => ({ id: provider.id, version: provider.version, available: provider.available, authenticated: provider.authenticated, models: provider.models.length })), computer: { accessibility: computer.accessibility, screenRecording: computer.screenRecording, paused: computer.paused, error: computer.error } }
  })
  assert.equal(states.providers.find(provider => provider.id === 'codex').version, 'codex-cli 0.153.3', 'Packaged binary must be used instead of old system CLI')
  const artifacts = path.resolve('artifacts-v2');fs.mkdirSync(artifacts, { recursive: true })
  await page.screenshot({ path: path.join(artifacts, 'packaged-transcript.png') })
  await page.getByText('index.html', { exact: true }).click()
  await page.waitForSelector('.panel-container.open')
  const files = await page.locator('[role="tabpanel"]').filter({ has: page.locator('textarea') }).count()
  const result = { packaged: true, switches: 4, transcriptCount: 1, messageCount: 2, filesPanelOpened: true, states, errors }
  fs.writeFileSync(path.join(artifacts, 'desktop-regression.json'), JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result))
  assert.deepEqual(errors, [])
  await browser.close()
}
main().catch(error => { console.error(error); process.exit(1) })
