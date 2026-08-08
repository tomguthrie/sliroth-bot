/** Escapes text for use in Discord's Markdown-like message syntax. */
export function escapeDiscordMarkdown(value: string): string {
  return value.replaceAll(/([\\`*_{}[\]()<>#+\-.!|~])/g, '\\$1');
}
