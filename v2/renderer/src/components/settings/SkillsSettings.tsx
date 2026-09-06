import { BookOpen, RefreshCw, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SkillInfo } from '../../../../shared/contracts'
import { api, errorText } from '../../api'
import { EmptyState, IconButton, Spinner, Toggle } from '../Primitives'
import type { SettingsSectionProps } from './types'
export function SkillsSettings({
  snapshot,
  onSettings,
  onRefresh,
  onError,
  notify,
}: SettingsSectionProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([])
  const [skillQuery, setSkillQuery] = useState('')
  const [skillLimit, setSkillLimit] = useState(80)
  const [skillsLoading, setSkillsLoading] = useState(false)
  const [skillFailure, setSkillFailure] = useState<string | null>(null)
  const [busySkills, setBusySkills] = useState<string[]>([])
  const loadSkills = async () => {
    setSkillsLoading(true)
    setSkillFailure(null)
    try {
      setSkills(await api<SkillInfo[]>('skills:list'))
    } catch (error) {
      setSkillFailure(errorText(error))
    } finally {
      setSkillsLoading(false)
    }
  }
  const toggleSkill = async (id: string, enabled: boolean) => {
    setBusySkills((current) => [...current, id])
    try {
      setSkills(await api<SkillInfo[]>('skills:toggle', { id, enabled }))
    } catch (error) {
      onError(error)
    } finally {
      setBusySkills((current) => current.filter((item) => item !== id))
    }
  }
  const filteredSkills = skills.filter((skill) =>
    `${skill.name} ${skill.description} ${skill.source}`
      .toLowerCase()
      .includes(skillQuery.toLowerCase()),
  )
  useEffect(() => {
    void loadSkills()
  }, [])
  return (
    <>
      <div className="settings-section-title with-action">
        <div>
          <h3>Skills</h3>
          <p>Instructions and expertise from your installed skill libraries.</p>
        </div>
        <IconButton
          label="Refresh skills"
          disabled={skillsLoading}
          onClick={() => void loadSkills()}
        >
          {skillsLoading ? <Spinner /> : <RefreshCw size={15} />}
        </IconButton>
      </div>
      <div className="settings-search">
        <Search size={15} />
        <input
          aria-label="Search skills"
          placeholder="Search skills…"
          value={skillQuery}
          onChange={(event) => {
            setSkillQuery(event.target.value)
            setSkillLimit(80)
          }}
        />
        <span>{skills.filter((skill) => skill.enabled).length} enabled</span>
      </div>
      {skillFailure ? <p className="panel-error">{skillFailure}</p> : null}
      <div className="skill-list">
        {filteredSkills.slice(0, skillLimit).map((skill) => (
          <div key={skill.id} className="skill-card">
            <div className="skill-icon">
              <BookOpen size={16} />
            </div>
            <div className="skill-info">
              <h4>{skill.name}</h4>
              <p>{skill.description || 'No description provided.'}</p>
              <details>
                <summary>{skill.source}</summary>
                <code>{skill.path}</code>
              </details>
            </div>
            <Toggle
              checked={skill.enabled}
              disabled={busySkills.includes(skill.id)}
              label={`Enable ${skill.name}`}
              onChange={(enabled) => void toggleSkill(skill.id, enabled)}
            />
          </div>
        ))}
        {filteredSkills.length > skillLimit ? (
          <button
            className="secondary-button load-more"
            onClick={() => setSkillLimit((value) => value + 80)}
          >
            Show more ({filteredSkills.length - skillLimit})
          </button>
        ) : null}
        {!skillsLoading && !filteredSkills.length ? (
          <EmptyState
            icon={<BookOpen size={28} />}
            title={skillQuery ? 'No matching skills' : 'No skills found'}
          >
            <p>
              {skillQuery
                ? 'Try another name or keyword.'
                : 'Installed Codex and project skill libraries will appear here.'}
            </p>
          </EmptyState>
        ) : null}
      </div>
      <p className="settings-bottom-note">
        Changes apply to new turns. Native provider skill support can differ between connections.
      </p>
    </>
  )
}
