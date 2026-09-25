/** Given name, or the full label when there is nothing to split (an email, for example). */
export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] || displayName;
}

/** Possessive of the given name, so "James" stays "James'" rather than "James's". */
export function possessive(displayName: string): string {
  const name = firstName(displayName);
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}
