import { ArrowDownToLine, Check, CircleAlert, Copy, Monitor, Moon, Sun } from 'lucide-react'
import { useState } from 'react'
import type { ProviderId, Settings } from '../../../../shared/contracts'
import { api } from '../../api'
import { IconButton, Spinner } from '../Primitives'
import type { SettingsSectionProps } from './types'

export interface ImportResult {
  projects: number
  tasks: number
  messages: number
  attachments: number
  skipped: {
    projects: number
    tasks: number
    messages: number
    attachments: number
    activities: number
    metadata: number
  }
  alreadyImported: { projects: number; tasks: number; messages: number }
  unverifiedMessages: number
  warningCount: number
  warnings: string[]
  backupPath: string
  attachmentManifestPath?: string
}

const count = (value: number, label: string, plural = `${label}s`) =>
  `${value} ${value === 1 ? label : plural}`

export function ImportReceipt({
  result,
  onCopyPath,
}: {
  result: ImportResult
  onCopyPath: (path: string, label: string) => void
}) {
  const skipped = [
    [result.skipped.projects, 'project', 'projects'],
    [result.skipped.tasks, 'task', 'tasks'],
    [result.skipped.messages, 'message', 'messages'],
    [result.skipped.attachments, 'attachment', 'attachments'],
    [result.skipped.activities, 'activity', 'activities'],
    [result.skipped.metadata, 'metadata field', 'metadata fields'],
  ] as const
  const hasSkipped = skipped.some(([value]) => value > 0)
  const warnings = result.warnings.slice(0, 100)
  return (
    <section
      className="import-result"
      aria-label="Import receipt"
      style={{ background: 'var(--surface-soft)', color: 'var(--text)' }}
    >
      {hasSkipped || result.warningCount > 0 || result.unverifiedMessages > 0 ? (
        <CircleAlert size={15} aria-hidden="true" style={{ flexShrink: 0 }} />
      ) : (
        <ArrowDownToLine size={15} aria-hidden="true" style={{ flexShrink: 0 }} />
      )}
      <div>
        <strong role="status">
          {hasSkipped
            ? 'Partial import — some data was skipped'
            : result.warningCount > 0 || result.unverifiedMessages > 0
              ? 'Import finished with notes'
              : 'Import finished'}
        </strong>
        <p aria-label="Newly copied data">
          <strong>Copied this time:</strong>{' '}
          {[
            count(result.projects, 'project'),
            count(result.tasks, 'task'),
            count(result.messages, 'message'),
            count(result.attachments, 'attachment'),
          ].join(' · ')}
        </p>
        <p aria-label="Previously imported data">
          <strong>Already imported:</strong>{' '}
          {[
            count(result.alreadyImported.projects, 'project'),
            count(result.alreadyImported.tasks, 'task'),
            count(result.alreadyImported.messages, 'message'),
          ].join(' · ')}
        </p>
        <p aria-label="Skipped data">
          <strong>Skipped:</strong>{' '}
          {hasSkipped
            ? skipped
                .filter(([value]) => value > 0)
                .map(([value, label, plural]) => count(value, label, plural))
                .join(' · ')
            : 'None'}
        </p>
        <p>
          <strong>Unverified outcomes:</strong> {count(result.unverifiedMessages, 'message')}.
          {result.unverifiedMessages > 0
            ? ' Copied history does not confirm that the original work succeeded.'
            : ''}
        </p>
        <p>
          Repeating import will not duplicate records already imported. Skipped data is listed
          separately.
        </p>
        {result.warningCount > 0 ? (
          <details>
            <summary>{count(result.warningCount, 'warning')}</summary>
            {result.warningCount > warnings.length ? (
              <p>Showing {warnings.length} of {result.warningCount} warning details.</p>
            ) : null}
            <ul>
              {warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          </details>
        ) : null}
        <details>
          <summary>Backup and import files</summary>
          {[
            { label: 'Backup path', path: result.backupPath },
            ...(result.attachmentManifestPath
              ? [{ label: 'Attachment manifest path', path: result.attachmentManifestPath }]
              : []),
          ].map((file) => (
            <div key={file.label}>
              <p>{file.label}</p>
              <div className="setup-command">
                <code style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{file.path}</code>
                <IconButton
                  label={`Copy ${file.label.toLowerCase()}`}
                  onClick={() => onCopyPath(file.path, file.label)}
                  style={{ flexShrink: 0 }}
                >
                  <Copy size={13} />
                </IconButton>
              </div>
            </div>
          ))}
        </details>
      </div>
    </section>
  )
}

export function GeneralSettings({
  snapshot,
  onSettings,
  onRefresh,
  onError,
  notify,
}: SettingsSectionProps) {
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<ImportResult | null>(null)
  const patchSettings = async (patch: Partial<Settings>) => {
    const next = await api<Settings>('settings:update', { patch })
    onSettings(next)
  }
  const providers = snapshot.providers
  return (
    <>
      <div className="settings-section-title">
        <h3>Make it yours</h3>
        <p>A quiet place for ambitious work.</p>
      </div>
      <section className="settings-section">
        <h4>Appearance</h4>
        <div className="theme-options">
          {(
            [
              { value: 'light', label: 'Light', icon: Sun },
              { value: 'dark', label: 'Dark', icon: Moon },
              { value: 'system', label: 'System', icon: Monitor },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              className={snapshot.settings.theme === option.value ? 'selected' : ''}
              onClick={() => void patchSettings({ theme: option.value }).catch(onError)}
            >
              <div className={`theme-preview ${option.value}`}>
                <i />
                <span>
                  <b />
                  <b />
                  <b />
                </span>
              </div>
              <span>
                <option.icon size={13} />
                {option.label}
                {snapshot.settings.theme === option.value ? <Check size={13} /> : null}
              </span>
            </button>
          ))}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-row">
          <div>
            <h4>Default connection</h4>
            <p>Used for new tasks. Existing tasks keep their selection.</p>
          </div>
          <select
            aria-label="Default provider"
            value={snapshot.settings.defaultProvider}
            onChange={(event) =>
              void patchSettings({
                defaultProvider: event.target.value as ProviderId,
              }).catch(onError)
            }
          >
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.name}
              </option>
            ))}
          </select>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-row">
          <div>
            <h4>Bring your history</h4>
            <p>
              Import projects and conversations from the previous Akorith app. Its data stays
              intact.
            </p>
          </div>
          <button
            className="secondary-button"
            disabled={importing}
            onClick={() => {
              setImporting(true)
              void api<ImportResult>('history:import')
                .then(async (result) => {
                  setImportResult(result)
                  await onRefresh()
                })
                .catch(onError)
                .finally(() => setImporting(false))
            }}
          >
            {importing ? <Spinner /> : <ArrowDownToLine size={14} />}Import
          </button>
        </div>
        {importResult ? (
          <ImportReceipt
            result={importResult}
            onCopyPath={(path, label) =>
              void navigator.clipboard.writeText(path)
                .then(() => notify(`${label} copied`))
                .catch(onError)
            }
          />
        ) : null}
      </section>
      <section className="settings-section">
        <h4>Keyboard shortcuts</h4>
        <div className="shortcut-list">
          {[
            ['New task', '⌘N'],
            ['Search tasks', '⌘K'],
            ['Show / hide sidebar', '⌘B'],
            ['Show / hide workspace panel', '⌘J'],
            ['Settings', '⌘,'],
            ['Send message', '↵'],
            ['New line', '⇧↵'],
          ].map(([label, key]) => (
            <div key={label}>
              <span>{label}</span>
              <kbd>{key}</kbd>
            </div>
          ))}
        </div>
      </section>
    </>
  )
}
