import { Check, FolderPlus } from 'lucide-react';
import { useState } from 'react';
import type { Project } from '../../../shared/contracts';
import { api } from '../api';
import { Dialog, Spinner } from './Primitives';

export function ProjectDialog({ project, onClose, onSaved }: {
  project: Project | null;
  onClose(): void;
  onSaved(project: Project): void;
}) {
  const [name, setName] = useState(project?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const creating = !project;
  const close = () => { if (!busy) onClose(); };
  return <Dialog title={creating ? 'New project' : 'Rename project'} onClose={close} className="small-dialog">
    <form onSubmit={event => {
      event.preventDefault();
      if (busy || !name.trim()) return;
      setBusy(true); setError('');
      void api<Project | null>(creating ? 'project:create' : 'project:rename', creating ? { name } : { projectId: project.id, name })
        .then(result => { if (result) onSaved(result); })
        .catch(error => setError(error instanceof Error ? error.message : String(error)))
        .finally(() => setBusy(false));
    }}>
      <label className="field-label" htmlFor="project-name">{creating ? 'Folder name' : 'Project name'}</label>
      <input id="project-name" autoFocus value={name} maxLength={200} disabled={busy}
        onChange={event => setName(event.target.value)} aria-describedby="project-name-description" />
      <p id="project-name-description" className="project-menu-description">{creating
        ? 'Choose where to create an empty folder for this project.'
        : 'Changes the sidebar name. Your folder and existing tasks stay in place.'}</p>
      {project ? <p className="project-menu-path">{project.path}</p> : null}
      {error ? <p role="alert" className="danger-text">{error}</p> : null}
      <div className="dialog-actions">
        <button type="button" className="secondary-button" disabled={busy} onClick={close}>Cancel</button>
        <button className="primary-button" disabled={busy || !name.trim()}>
          {busy ? <Spinner size={14} /> : creating ? <FolderPlus size={14} /> : <Check size={14} />}
          {busy ? creating ? 'Choosing location…' : 'Saving…' : creating ? 'Choose location…' : 'Save name'}
        </button>
      </div>
    </form>
  </Dialog>;
}
