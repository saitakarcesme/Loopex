export function projectDisplayName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value))
    throw new Error('Use a project name between 1 and 200 characters without control characters.');
  return value.trim();
}
export function projectFolderName(value: unknown): string {
  const name = projectDisplayName(value);
  if (name !== value || name.startsWith('.') || /[\\/:*?"<>|]/.test(name) || /[. ]$/.test(name)
    || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name) || Buffer.byteLength(name, 'utf8') > 255)
    throw new Error('Use a single visible folder name without slashes, reserved characters, or surrounding spaces.');
  return name;
}
