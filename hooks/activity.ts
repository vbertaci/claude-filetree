import type { PluginOptions, ToolCallInput, ToolCallResult } from 'claude-code'

import type { ActivityState, FileNode, Glow, Tone, TreeState } from '../types'
import { BRANCH_ID } from './git'
import type { Paths } from './os'
import { visibleRows } from './tree'

// Pure functions over Claude's activity: what counts, what lights and what changed. Nothing here calls `$`.

export const FLASH_MS = 2700
export const SEARCH_LIMIT = 60
export const SCAN_DIR_LIMIT = 100
export const SCAN_LIT_LIMIT = 200

export type Settings = { reads: boolean; writes: boolean; follow: boolean }

/** What a tool call touched, already filtered by R2. */
export type Touch = { kind: 'read'; ids: string[] } | { kind: 'write'; ids: string[] } | { kind: 'scan' }

const ACTIVITY = ['reads and writes', 'writes', 'reads', 'none']

export function emptyActivity(): ActivityState {
  return { root: '', lit: {}, focus: '', until: 0 }
}

export function settingsOf(options: PluginOptions): Settings {
  const activity = typeof options.activity === 'string' && ACTIVITY.includes(options.activity) ? options.activity : 'reads and writes'
  return { reads: activity.includes('reads'), writes: activity.includes('writes'), follow: options.follow !== 'off' }
}

const REFRESH: Record<string, number | null> = { off: null, '2s': 2_000, '5s': 5_000, '10s': 10_000 }

/** The period of the `refresh` option; an unknown value is the default (spec-05 R1.1). */
export function refreshMsOf(options: PluginOptions): number | null {
  const v = typeof options.refresh === 'string' && options.refresh in REFRESH ? options.refresh : '5s'
  return REFRESH[v] ?? null
}

/** A field of the tool's record; the record is the tool's, so nothing about it is assumed. */
function field(result: ToolCallResult, name: string): unknown {
  const record = result.result
  return typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[name] : undefined
}

export function touchOf(
  e: ToolCallInput,
  result: ToolCallResult,
  ctx: { paths: Paths; cwd: string; home: string; root: string },
): Touch | null {
  const ok = result.deny === undefined && result.isError === undefined
  const within = (inputs: readonly unknown[]): string[] => {
    const ids: string[] = []
    const seen = new Set<string>()
    for (const input of inputs) {
      if (typeof input !== 'string') continue
      const id = ctx.paths.resolve(ctx.cwd, input, ctx.home)
      if (id === null || !ctx.paths.inside(ctx.root, id) || ctx.paths.same(ctx.root, id) || seen.has(ctx.paths.key(id))) continue
      seen.add(ctx.paths.key(id))
      ids.push(id)
    }
    return ids
  }
  const touched = (kind: 'read' | 'write', inputs: readonly unknown[]): Touch | null => {
    const ids = within(inputs)
    return ids.length > 0 ? { kind, ids } : null
  }

  if (e.tool === 'Bash' || e.tool === 'PowerShell') {
    const background = field(result, 'backgroundTaskId')
    return result.deny === undefined && !result.isReadOnly && (typeof background !== 'string' || background === '') ? { kind: 'scan' } : null
  }
  if (!ok) return null
  if (e.tool === 'Read') return touched('read', [e.file_path])
  if (e.tool === 'Grep' || e.tool === 'Glob') {
    const filenames = field(result, 'filenames')
    return Array.isArray(filenames) ? touched('read', filenames.slice(0, SEARCH_LIMIT)) : null
  }
  if (e.tool === 'Edit' || e.tool === 'Write') return touched('write', [e.file_path])
  if (e.tool === 'NotebookEdit') return touched('write', [e.notebook_path])
  return null
}

export function scanDirs(t: TreeState): string[] {
  const open = visibleRows(t).filter(r => r.isOpen && r.node.loaded)
  return [t.root, ...open.map(r => r.id)].slice(0, SCAN_DIR_LIMIT)
}

/** Files written since `since`, and children that were not there before (R6.3). */
export function changedIn(before: ReadonlySet<string> | undefined, children: readonly FileNode[], since: number): string[] {
  return children.filter(c => (c.kind === 'file' && c.mtimeMs >= since) || (before !== undefined && !before.has(c.name))).map(c => c.id)
}

/** The folders between the root and `id`, both excluded, shallowest first. */
export function ancestorsOf(paths: Paths, root: string, id: string): string[] {
  const dirs: string[] = []
  for (let at = paths.parent(id); at !== null && !paths.same(at, root) && paths.inside(root, at); at = paths.parent(at)) dirs.unshift(at)
  return dirs
}

export function isLive(a: ActivityState, root: string, now: number): boolean {
  return a.until > now && a.root === root
}

/** Lights `ids` and opens their ancestors; `activity === a` when nothing lit. */
export function light(a: ActivityState, t: TreeState, paths: Paths, ids: readonly string[], tone: Tone, now: number) {
  const present = new Set(t.nodes.map(n => n.id))
  const open = new Set(t.expanded)
  const lit: Record<string, Glow> = isLive(a, t.root, now) ? { ...a.lit } : {}
  let focus = ''
  for (const id of ids) {
    if (!present.has(id)) continue
    for (const dir of ancestorsOf(paths, t.root, id)) {
      if (open.has(dir)) continue
      open.add(dir)
      // An ancestor this reveal opened glows faint, unless it is lit bright already (R5.2).
      if (!lit[dir] || lit[dir].faint) lit[dir] = { tone, faint: true }
    }
    lit[id] = { tone }
    focus = id
  }
  if (focus === '') return { activity: a, expanded: t.expanded }
  return { activity: { root: t.root, lit, focus, until: now + FLASH_MS }, expanded: [...open] }
}

/** Joins the branch row's glow to a live one, as `light` does with nodes (spec-04 R6.2). */
export function lightBranch(a: ActivityState, root: string, tone: Tone, now: number): ActivityState {
  const live = isLive(a, root, now)
  const lit: Record<string, Glow> = live ? { ...a.lit } : {}
  lit[BRANCH_ID] = { tone }
  return { root, lit, focus: live ? a.focus : '', until: now + FLASH_MS }
}

/** The index the top row of `before`'s window has in `after`; `before.scroll` when it is gone (R7.3). */
export function keepTop(before: TreeState, after: TreeState, from: number): number | null {
  const top = visibleRows(before)[before.scroll ?? from]
  const at = top ? visibleRows(after).findIndex(r => r.id === top.id) : -1
  return at < 0 ? before.scroll : at
}
