// v4 (4.6): shared snippet helpers — language guess + capacity constants.

/** Composer cap raised from 10 KB to 1 MB: the transfer pipeline chunks big
 * snippets like any file (64 KB frames + gzip), so only UX bounds it. */
export const SNIPPET_MAX_CHARS = 1_000_000

/** Snippet→QR payload cap: ~800 chars stays scannable at phone distance. */
export const SNIPPET_QR_MAX_CHARS = 800

/** Trusted-peer auto-accept snippet scope (v1.3 6.4) — mirrored bound. */
export const SNIPPEET_TRUSTED_MAX_BYTES = 100 * 1024

/** Cheap heuristic language guess for syntax highlighting. */
export function guessSnippetLanguage(text: string): string {
  const head = text.slice(0, 4000)
  const t = text.trim()
  if ((t.startsWith('{') || t.startsWith('[')) && /["}\]]\s*$/.test(t)) return 'json'
  if (/^#{1,6}\s|\n[-*]\s|\]\(http/.test(head) && !/[;{}]/.test(t.slice(0, 200))) return 'markdown'
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE TABLE)\b/i.test(t)) return 'sql'
  if (/^\s*(?:#!\/bin\/(ba)?sh|npm |yarn |bun |git |cd |ls |sudo )/m.test(head)) return 'bash'
  if (/\b(def |import |from \w+ import|print\()/.test(head)) return 'python'
  if (/\b(function |const |let |=>|import \{|\binterface \w+)/.test(head)) return 'typescript'
  if (/^\s*[a-z-]+\s*\{[^}]*:[^}]*;/m.test(head)) return 'css'
  if (/^\s*<(!DOCTYPE|html|div|span|svg)/i.test(t)) return 'markup'
  return 'text'
}

/** Does this look like Markdown worth rendering? */
export function looksLikeMarkdown(text: string): boolean {
  const t = text.slice(0, 2000)
  let score = 0
  if (/^#{1,6}\s/m.test(t)) score += 2
  if (/\n\s*[-*+]\s/m.test(t)) score += 1
  if (/`[^`\n]+`/.test(t)) score += 1
  if (/\[[^\]]+\]\([^)]+\)/.test(t)) score += 2
  if (/\n\|\s*---/.test(t)) score += 1
  return score >= 2
}
