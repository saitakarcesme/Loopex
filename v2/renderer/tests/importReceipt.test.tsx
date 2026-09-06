import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  ImportReceipt,
  type ImportResult,
} from '../src/components/settings/GeneralSettings'

const receipt = (patch: Partial<ImportResult> = {}): ImportResult => ({
  projects: 1,
  tasks: 2,
  messages: 7,
  attachments: 0,
  skipped: { projects: 0, tasks: 0, messages: 0, attachments: 0, activities: 0, metadata: 0 },
  alreadyImported: { projects: 0, tasks: 0, messages: 0 },
  unverifiedMessages: 0,
  warningCount: 0,
  warnings: [],
  backupPath: '/fixture/backups/old history.sqlite',
  ...patch,
})
const render = (result: ImportResult) =>
  renderToStaticMarkup(<ImportReceipt result={result} onCopyPath={() => {}} />)
const paragraph = (html: string, label: string) =>
  html.match(new RegExp(`<p aria-label="${label}">(.*?)</p>`))?.[1].replace(/<[^>]*>/g, '')

test('newly copied counts remain explicit, including zero attachments and unverified outcomes', () => {
  const html = render(receipt({ unverifiedMessages: 3 }))
  assert.equal(
    paragraph(html, 'Newly copied data'),
    'Copied this time: 1 project · 2 tasks · 7 messages · 0 attachments',
  )
  assert.match(html, /role="status">Import finished with notes</)
  assert.match(html, /Unverified outcomes:<\/strong> 3 messages/)
  assert.match(html, /Copied history does not confirm that the original work succeeded/)
  assert.doesNotMatch(html, /Successfully imported|lucide-check/)
})

test('partial import names every skipped category separately from copied data', () => {
  const html = render(receipt({
    attachments: 4,
    skipped: { projects: 1, tasks: 2, messages: 3, attachments: 4, activities: 5, metadata: 6 },
  }))
  assert.match(html, /role="status">Partial import — some data was skipped</)
  assert.equal(
    paragraph(html, 'Skipped data'),
    'Skipped: 1 project · 2 tasks · 3 messages · 4 attachments · 5 activities · 6 metadata fields',
  )
  assert.match(paragraph(html, 'Newly copied data')!, /4 attachments$/)
  assert.doesNotMatch(html, /lucide-check/)
})

test('repeat imports distinguish already imported records from new copies and skips', () => {
  const html = render(receipt({
    projects: 0,
    tasks: 0,
    messages: 0,
    alreadyImported: { projects: 1, tasks: 2, messages: 7 },
  }))
  assert.equal(
    paragraph(html, 'Newly copied data'),
    'Copied this time: 0 projects · 0 tasks · 0 messages · 0 attachments',
  )
  assert.equal(
    paragraph(html, 'Previously imported data'),
    'Already imported: 1 project · 2 tasks · 7 messages',
  )
  assert.equal(paragraph(html, 'Skipped data'), 'Skipped: None')
  assert.match(html, /Repeating import will not duplicate records already imported/)
  assert.doesNotMatch(html, /Partial import/)
})

test('warning details stay bounded while displaying the full warning count', () => {
  const html = render(receipt({
    warningCount: 205,
    warnings: Array.from({ length: 101 }, (_, index) => `Import warning ${index + 1}`),
  }))
  assert.match(html, /<summary>205 warnings<\/summary>/)
  assert.match(html, /Showing 100 of 205 warning details/)
  assert.equal((html.match(/<li>/g) ?? []).length, 100)
  assert.match(html, />Import warning 100<\/li>/)
  assert.doesNotMatch(html, />Import warning 101<\/li>/)
})

test('backup and manifest paths are readable and copyable without opening files outside scope', () => {
  const html = render(receipt({
    backupPath: '/fixture/backups/a & b.sqlite',
    attachmentManifestPath: '/fixture/import manifest.json',
  }))
  assert.match(html, /a &amp; b.sqlite<\/code>/)
  assert.match(html, /\/fixture\/import manifest.json<\/code>/)
  assert.match(html, /aria-label="Copy backup path"/)
  assert.match(html, /aria-label="Copy attachment manifest path"/)
  assert.doesNotMatch(html, /href=|Reveal|Open file|<script/)
  assert.doesNotMatch(render(receipt()), /Copy attachment manifest path/)
})
