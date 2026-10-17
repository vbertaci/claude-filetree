import type { FsEntry } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { ActivityState, TreeState } from '../types'
import {
  FLASH_MS,
  ancestorsOf,
  changedIn,
  emptyActivity,
  isLive,
  keepTop,
  light,
  scanDirs,
  settingsOf,
  touchOf,
} from '../hooks/activity'
import { paths } from '../hooks/os'
import { emptyTree, replaceChildren, toNodes } from '../hooks/tree'

const P = paths('windows')
const ROOT = 'C:/p'
const CTX = { paths: P, cwd: ROOT, home: 'C:/Users/me', root: ROOT }

const entry = (name: string, kind: FsEntry['kind'] = 'file', mtimeMs = 5): FsEntry => ({ name, kind, size: 1, mtimeMs, isLink: false })
const call = (tool: string, input: Record<string, unknown> = {}) => ({ tool, tool_use_id: 't1', ...input }) as any
const ok = (record: unknown = {}, extra: Record<string, unknown> = {}) => ({ result: record, ref: 1, text: '', ...extra }) as any

/** C:/p: src/ (a/ (x.ts), b.ts), c.md; src and src/a loaded, nothing open. */
function sample(): TreeState {
  let t = emptyTree(ROOT, true)
  t = replaceChildren(P, t, ROOT, toNodes(P, ROOT, [entry('src', 'dir'), entry('c.md')]))
  t = replaceChildren(P, t, 'C:/p/src', toNodes(P, 'C:/p/src', [entry('a', 'dir'), entry('b.ts')]))
  t = replaceChildren(P, t, 'C:/p/src/a', toNodes(P, 'C:/p/src/a', [entry('x.ts')]))
  return t
}

describe('settingsOf (R3.1, R3.4)', () => {
  test('each value, and an unknown one as the default', () => {
    expect(settingsOf({})).toEqual({ reads: true, writes: true, follow: true })
    expect(settingsOf({ activity: 'writes', follow: 'off' })).toEqual({ reads: false, writes: true, follow: false })
    expect(settingsOf({ activity: 'reads' })).toEqual({ reads: true, writes: false, follow: true })
    expect(settingsOf({ activity: 'none' })).toEqual({ reads: false, writes: false, follow: true })
    expect(settingsOf({ activity: 'nonsense', follow: 'maybe' })).toEqual({ reads: true, writes: true, follow: true })
  })
})

describe('touchOf (R2)', () => {
  test('Read, Edit, Write and NotebookEdit name one file', () => {
    expect(touchOf(call('Read', { file_path: 'C:\\p\\src\\b.ts' }), ok(), CTX)).toEqual({ kind: 'read', ids: ['C:/p/src/b.ts'] })
    expect(touchOf(call('Edit', { file_path: 'c:/p/c.md' }), ok(), CTX)).toEqual({ kind: 'write', ids: ['C:/p/c.md'] })
    expect(touchOf(call('Write', { file_path: 'C:/p/new.md' }), ok(), CTX)).toEqual({ kind: 'write', ids: ['C:/p/new.md'] })
    expect(touchOf(call('NotebookEdit', { notebook_path: 'C:/p/n.ipynb' }), ok(), CTX)).toEqual({ kind: 'write', ids: ['C:/p/n.ipynb'] })
  })

  test('a deny or an error counts for nothing, except on a shell', () => {
    const read = call('Read', { file_path: 'C:/p/c.md' })
    expect(touchOf(read, { deny: 'no' } as any, CTX)).toBe(null)
    expect(touchOf(read, { isError: true, result: 'boom' } as any, CTX)).toBe(null)
    expect(touchOf(call('PowerShell', { command: 'x' }), { isError: true, result: 'boom' } as any, CTX)).toEqual({ kind: 'scan' })
    expect(touchOf(call('Bash', { command: 'x' }), { deny: 'no' } as any, CTX)).toBe(null)
  })

  test('Grep and Glob take the first 60 filenames, resolved against the cwd', () => {
    const filenames = Array.from({ length: 70 }, (_, i) => (i % 2 ? `src\\f${i}.ts` : `C:\\p\\g${i}.ts`))
    const touch = touchOf(call('Grep', { pattern: 'x' }), ok({ filenames }), CTX)
    expect(touch?.kind).toBe('read')
    const ids = touch && 'ids' in touch ? touch.ids : []
    expect(ids).toHaveLength(60)
    expect(ids.slice(0, 2)).toEqual(['C:/p/g0.ts', 'C:/p/src/f1.ts'])
    expect(touchOf(call('Glob', { pattern: '*' }), ok({ filenames: [] }), CTX)).toBe(null)
  })

  test('a shell scans unless read-only or in the background', () => {
    expect(touchOf(call('Bash', { command: 'touch x' }), ok({ stdout: '' }), CTX)).toEqual({ kind: 'scan' })
    expect(touchOf(call('PowerShell', { command: 'gci' }), ok({}, { isReadOnly: true }), CTX)).toBe(null)
    expect(touchOf(call('Bash', { command: 'x', run_in_background: true }), ok({ backgroundTaskId: 'b1' }), CTX)).toBe(null)
  })

  test('other tools, paths outside the root, the root itself and repeats', () => {
    expect(touchOf(call('mcp__srv__read', { file_path: 'C:/p/c.md' }), ok(), CTX)).toBe(null)
    expect(touchOf(call('WebFetch', { url: 'https://x' }), ok(), CTX)).toBe(null)
    expect(touchOf(call('Read', { file_path: 'C:/q/c.md' }), ok(), CTX)).toBe(null)
    expect(touchOf(call('Read', { file_path: 'C:/p' }), ok(), CTX)).toBe(null)
    expect(touchOf(call('Glob', {}), ok({ filenames: ['C:/p/c.md', 'c.md', 'C:/elsewhere/z'] }), CTX)).toEqual({ kind: 'read', ids: ['C:/p/c.md'] })
  })
})

describe('scan helpers (R6.2, R6.3)', () => {
  test('scanDirs: the root, then open and loaded rows in row order, up to 100', () => {
    const t = { ...sample(), expanded: ['C:/p/src', 'C:/p/src/a'] }
    expect(scanDirs(t)).toEqual([ROOT, 'C:/p/src', 'C:/p/src/a'])
    expect(scanDirs({ ...t, expanded: ['C:/p/src/a'] })).toEqual([ROOT])
    const many = Array.from({ length: 120 }, (_, i) => entry(`d${String(i).padStart(3, '0')}`, 'dir'))
    let wide = replaceChildren(P, emptyTree(ROOT, true), ROOT, toNodes(P, ROOT, many))
    for (const n of wide.nodes) wide = replaceChildren(P, wide, n.id, [])
    wide = { ...wide, expanded: wide.nodes.map(n => n.id) }
    expect(scanDirs(wide)).toHaveLength(100)
  })

  test('changedIn: newer files and new names; without a snapshot, only the date', () => {
    const kids = toNodes(P, ROOT, [entry('old.ts', 'file', 10), entry('new.ts', 'file', 50), entry('made', 'dir', 0), entry('kept', 'dir', 0)])
    expect(changedIn(new Set(['old.ts', 'new.ts', 'kept']), kids, 50)).toEqual(['C:/p/made', 'C:/p/new.ts'])
    expect(changedIn(undefined, kids, 50)).toEqual(['C:/p/new.ts'])
  })
})

describe('light (R4.4, R4.5, R5.1, R5.2)', () => {
  test('opens the closed ancestors, faint, and lights the file bright', () => {
    const t = { ...sample(), expanded: ['C:/p/src'] }
    const r = light(emptyActivity(), t, P, ['C:/p/src/a/x.ts'], 'read', 1000)
    expect(r.expanded).toEqual(['C:/p/src', 'C:/p/src/a'])
    expect(r.activity).toEqual({ root: ROOT, lit: { 'C:/p/src/a': { tone: 'read', faint: true }, 'C:/p/src/a/x.ts': { tone: 'read' } }, focus: 'C:/p/src/a/x.ts', until: 1000 + FLASH_MS })
  })

  test('an id the tree does not hold lights nothing and returns the same object', () => {
    const a = emptyActivity()
    const r = light(a, sample(), P, ['C:/p/src/a/gone.ts'], 'write', 1000)
    expect(r.activity).toBe(a)
    expect(r.expanded).toEqual([])
  })

  test('a live glow merges: bright beats faint, the latest tone wins, the deadline moves', () => {
    const first = light(emptyActivity(), sample(), P, ['C:/p/src/a/x.ts'], 'read', 1000)
    const t = { ...sample(), expanded: first.expanded }
    const second = light(first.activity, t, P, ['C:/p/src/a', 'C:/p/c.md', 'C:/p/src/a/x.ts'], 'write', 2000)
    expect(second.activity.lit).toEqual({
      'C:/p/src': { tone: 'read', faint: true },
      'C:/p/src/a': { tone: 'write' },
      'C:/p/c.md': { tone: 'write' },
      'C:/p/src/a/x.ts': { tone: 'write' },
    })
    expect(second.activity.until).toBe(2000 + FLASH_MS)
    expect(second.activity.focus).toBe('C:/p/src/a/x.ts')
  })

  test('an ended glow or another root is not carried over', () => {
    const old: ActivityState = { root: ROOT, lit: { 'C:/p/c.md': { tone: 'read' } }, focus: 'C:/p/c.md', until: 900 }
    expect(light(old, sample(), P, ['C:/p/src/b.ts'], 'read', 1000).activity.lit).toEqual({
      'C:/p/src': { tone: 'read', faint: true },
      'C:/p/src/b.ts': { tone: 'read' },
    })
    expect(isLive(old, ROOT, 899)).toBe(true)
    expect(isLive(old, ROOT, 900)).toBe(false)
    expect(isLive(old, 'C:/q', 899)).toBe(false)
  })
})

describe('ancestorsOf and keepTop', () => {
  test('ancestorsOf: shallowest first, the root and the id left out', () => {
    expect(ancestorsOf(P, ROOT, 'C:/p/src/a/x.ts')).toEqual(['C:/p/src', 'C:/p/src/a'])
    expect(ancestorsOf(P, ROOT, 'C:/p/c.md')).toEqual([])
  })

  test('keepTop: the top row keeps its place; gone, the scroll stays', () => {
    const before = sample()
    const after = { ...before, expanded: ['C:/p/src'] }
    expect(keepTop(before, after, 1)).toBe(3)
    expect(keepTop({ ...before, scroll: 0 }, after, 1)).toBe(0)
    expect(keepTop({ ...before, scroll: 7 }, after, 0)).toBe(7)
  })
})
