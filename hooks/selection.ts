import type { PluginOptions } from 'claude-code'

import type { Paths } from './os'

// Pure functions over how the selection reaches the prompt, always in plain sight (spec-09). Nothing here calls `$`.

export type SelectionMode = 'mention' | 'append' | 'off'

/** The `selection` option; unknown is 'mention' (R1.1). */
export function selectionOf(options: PluginOptions): SelectionMode {
  const v = options.selection
  return v === 'append' || v === 'off' ? v : 'mention'
}

/** What follows the @: relative to the cwd inside it, else absolute; '/' separators either way. */
export function referenceOf(paths: Paths, cwd: string, id: string): string {
  return paths.inside(cwd, id) && !paths.same(cwd, id) ? paths.relative(cwd, id) : paths.norm(id)
}

/** @ref, quoted when it holds white space (R2.1). */
export function mentionOf(ref: string): string {
  return /\s/.test(ref) ? `@"${ref}"` : `@${ref}`
}

/** The prompt with the selection line at its end, or null when the prompt already names it, any case (R3.1). */
export function appended(text: string, ref: string): string | null {
  return text.toLowerCase().includes(ref.toLowerCase()) ? null : `${text}\n\n(selected in the file tree: ${ref})`
}