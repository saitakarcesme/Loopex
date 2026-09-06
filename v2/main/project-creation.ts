import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './storage';
import { projectFolderName } from './project-names';

/** Native picker chooses the parent; mkdir without recursive never replaces an entry. */
export function createProjectFolder(store: Store, parentPath: string, input: unknown) {
  const name = projectFolderName(input);
  const parent = realpathSync(parentPath);
  if (!statSync(parent).isDirectory()) throw new Error('Choose a parent folder.');
  const path = join(parent, name);
  if (store.projects().some(project => project.path === path))
    throw new Error('That project is already registered. Open it or relocate its folder instead.');
  try { mkdirSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('A file or folder with that name already exists. Choose another name or open the existing folder.');
    throw error;
  }
  try { return store.addProject(realpathSync(path), name); }
  catch (error) {
    // Keep the new directory available for recovery; never remove user-owned data.
    throw new Error(`Created ${path}, but could not save the project. Open that folder to recover. ${error instanceof Error ? error.message : String(error)}`);
  }
}
