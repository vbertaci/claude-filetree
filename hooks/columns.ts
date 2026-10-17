import type { PluginOptions } from 'claude-code'

import type { ColumnsState, FileNode } from '../types'
import { formatDate } from './tree'

// Pure functions over the right column: which mode it is in and what each row shows. Nothing here calls `$`.

export type ColumnMode = 'date' | 'age' | 'size'

export const DATE_WIDTH = 16
export const AGE_WIDTH = 6
export const SIZE_WIDTH = 8
export const SIZE_LIMIT = 50_000
export const SIZE_JOBS = 2
export const AGE_TICK_MS = 60_000

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function emptyColumns(): ColumnsState {
  return { root: '', size: null, bytes: {} }
}

/** The `column` option; unknown is 'date' (R1.1). */
export function columnOf(options: PluginOptions): ColumnMode {
  const v = options.column
  return v === 'age' || v === 'size' ? v : 'date'
}

/** The time mode the Σ button goes back to: the option, or 'date' when the option is 'size' (R1.3). */
export function timeModeOf(option: ColumnMode): 'date' | 'age' {
  return option === 'age' ? 'age' : 'date'
}

/** The mode for this root: Σ's choice when it was made under this root, else the option (R1.4). */
export function modeOf(c: ColumnsState, root: string, option: ColumnMode): ColumnMode {
  if (c.root !== root || c.size === null) return option
  return c.size ? 'size' : timeModeOf(option)
}

export function widthOf(mode: ColumnMode): number {
  return mode === 'date' ? DATE_WIDTH : mode === 'age' ? AGE_WIDTH : SIZE_WIDTH
}

/** '?' for -1; bytes below 1 K; then K, M, G, T with one decimal under 100 (spec-07 Formatos). */
export function formatSize(bytes: number): string {
  if (bytes < 0) return '?'
  if (bytes < 1024) return `${bytes} B`
  const units = ['K', 'M', 'G', 'T']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 100 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** now, 12m, 3h, 5d, then Oct 9 within a year, then the year; '' for no time (spec-07 Formatos). */
export function formatAge(ms: number, now: number): string {
  if (ms === 0) return ''
  const s = (now - ms) / 1000
  if (Math.abs(s) < 60) return 'now'
  if (s > 0 && s < 3600) return `${Math.floor(s / 60)}m`
  if (s > 0 && s < 86_400) return `${Math.floor(s / 3600)}h`
  if (s > 0 && s < 7 * 86_400) return `${Math.floor(s / 86_400)}d`
  const d = new Date(ms)
  return Math.abs(s) < 365 * 86_400 ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : String(d.getFullYear())
}

/** What the column shows for a row, before alignment; '' leaves it empty (R2). */
export function cellText(mode: ColumnMode, node: FileNode, bytes: number | undefined, now: number): string {
  if (mode === 'size') {
    if (node.kind === 'file') return formatSize(node.size)
    if (node.kind === 'dir') return bytes === undefined ? '…' : formatSize(bytes)
    return ''
  }
  if (node.kind !== 'file') return ''
  return mode === 'age' ? formatAge(node.mtimeMs, now) : formatDate(node.mtimeMs)
}
