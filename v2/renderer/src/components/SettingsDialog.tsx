import { BookOpen, Cable, Layers3, Package, Settings2 } from 'lucide-react'
import { useState } from 'react'
import { Dialog } from './Primitives'
import { ConnectionsSettings } from './settings/ConnectionsSettings'
import { GeneralSettings } from './settings/GeneralSettings'
import { McpSettings } from './settings/McpSettings'
import { PluginsSettings } from './settings/PluginsSettings'
import { SkillsSettings } from './settings/SkillsSettings'
import type { SettingsSectionProps } from './settings/types'
type SettingsTab = 'general' | 'connections' | 'skills' | 'mcp' | 'plugins'
const tabs = [
  { id: 'general', name: 'General', icon: Settings2 },
  { id: 'connections', name: 'Connections', icon: Cable },
  { id: 'plugins', name: 'Plugins', icon: Package },
  { id: 'skills', name: 'Skills', icon: BookOpen },
  { id: 'mcp', name: 'MCP servers', icon: Layers3 },
] as const
export function SettingsDialog({
  initialTab = 'general',
  onClose,
  ...props
}: SettingsSectionProps & { initialTab?: SettingsTab; onClose: () => void }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab)
  return (
    <Dialog title="Settings" onClose={onClose} className="settings-dialog">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {tabs.map((item) => (
            <button
              key={item.id}
              className={tab === item.id ? 'selected' : ''}
              onClick={() => setTab(item.id)}
            >
              <item.icon size={16} />
              {item.name}
            </button>
          ))}
          <div className="settings-version">
            Akorith Next
            <br />
            <span>{props.snapshot.version}</span>
          </div>
        </nav>
        <div className="settings-content">
          {tab === 'general' ? (
            <GeneralSettings {...props} />
          ) : tab === 'connections' ? (
            <ConnectionsSettings {...props} />
          ) : tab === 'skills' ? (
            <SkillsSettings {...props} onManagePlugins={() => setTab('plugins')} />
          ) : tab === 'plugins' ? (
            <PluginsSettings {...props} />
          ) : (
            <McpSettings {...props} onManagePlugins={() => setTab('plugins')} />
          )}
        </div>
      </div>
    </Dialog>
  )
}
