import type { FsEntry } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { TreeState } from '../types'
import { paths } from '../hooks/os'
import {
  MEMORY_LIMIT,
  collapseAll,
  emptyTree,
  formatDate,
  markUnreadable,
  navigate,
  remember,
  replaceChildren,
  toNodes,
  toggle,
  toggleHidden,
  visibleRows,
  windowOf,
} from '../hooks/tree'

const P = paths('windows')
const ROOT = 'C:/p'

const entry = (name: string, kind: FsEntry['kind'] = 'file', isLink = false): FsEntry => ({ name, kind, size: 1, mtimeMs: 5, isLink })

/** A tree under C:/p: src/ (a.ts, lib/), .git/, b.md; src loaded and open. */
function sample(): TreeState {
  let t = emptyTree(ROOT, true)
  t = replaceChildren(P, t, ROOT, toNodes(P, ROOT, [entry('b.md'), entry('src', 'dir'), entry('.git', 'dir')]))
  t = replaceChildren(P, t, 'C:/p/src', toNodes(P, 'C:/p/src', [entry('lib', 'dir'), entry('a.ts')]))
  return { ...t, expanded: ['C:/p/src'] }
}

describe('toNodes (R3.1–R3.3)', () => {
  test('maps kinds, links and hidden', () => {
    const nodes = toNodes(P, ROOT, [entry('f'), entry('d', 'dir'), entry('l', 'other', true), entry('s', 'other'), entry('.h')])
    const kinds = Object.fromEntries(nodes.map(n => [n.name, n.kind]))
    expect(kinds).toEqual({ f: 'file', d: 'dir', l: 'link', s: 'other', '.h': 'file' })
    expect(nodes.find(n => n.name === '.h')?.hidden).toBe(true)
    expect(nodes.find(n => n.name === 'f')?.id).toBe('C:/p/f')
    expect(nodes.find(n => n.name === 'f')?.parent).toBe(ROOT)
  })

  test('folders first, then natural case-insensitive order', () => {
    const names = toNodes(P, ROOT, ['a10', 'a2', 'B', 'a', 'c'].map(n => entry(n)).concat(entry('z', 'dir'), entry('.git', 'dir'))).map(n => n.name)
    expect(names).toEqual(['.git', 'z', 'a', 'a2', 'a10', 'B', 'c'])
  })
})

describe('visibleRows (R3.4, R3.5)', () => {
  test('walks open and loaded folders, hidden shown by default', () => {
    const rows = visibleRows(sample())
    expect(rows.map(r => `${r.depth}:${r.node.name}`)).toEqual(['0:.git', '0:src', '1:lib', '1:a.ts', '0:b.md'])
  })

  test('hides hidden entries and their subtrees', () => {
    const rows = visibleRows({ ...sample(), showHidden: false })
    expect(rows.map(r => r.node.name)).toEqual(['src', 'lib', 'a.ts', 'b.md'])
  })

  test('keep: only kept ids; a folder is open when a kept child shows, whatever expanded says (spec-06 R3.1, R3.2)', () => {
    let t = replaceChildren(P, sample(), 'C:/p/src/lib', toNodes(P, 'C:/p/src/lib', [entry('x.ts')]))
    t = { ...t, expanded: [] }
    const keep = new Set(['C:/p/src', 'C:/p/src/lib', 'C:/p/src/lib/x.ts', 'C:/p/.git'])
    const rows = visibleRows(t, keep)
    expect(rows.map(r => `${r.depth}:${r.node.name}:${r.isOpen}`)).toEqual(['0:.git:false', '0:src:true', '1:lib:true', '2:x.ts:false'])
    expect(visibleRows({ ...t, showHidden: false }, keep).map(r => r.node.name)).toEqual(['src', 'lib', 'x.ts'])
    // An open folder with no kept child shows closed.
    expect(visibleRows(sample(), new Set(['C:/p/src'])).map(r => `${r.node.name}:${r.isOpen}`)).toEqual(['src:false'])
  })

  test('keep null is the same as no keep (spec-06 R3.3)', () => {
    expect(visibleRows(sample(), null)).toEqual(visibleRows(sample()))
  })
})

describe('replaceChildren (R7.2, R7.3)', () => {
  test('keeps loaded folders and drops what vanished', () => {
    let t = { ...sample(), cursor: 'C:/p/src/a.ts', selected: 'C:/p/src/a.ts', expanded: ['C:/p/src', 'C:/p/src/lib'] }
    t = replaceChildren(P, t, ROOT, toNodes(P, ROOT, [entry('src', 'dir')]))
    expect(t.nodes.find(n => n.id === 'C:/p/src')?.loaded).toBe(true)
    expect(t.nodes.some(n => n.id === 'C:/p/src/a.ts')).toBe(true)
    expect(t.nodes.some(n => n.id === 'C:/p/b.md')).toBe(false)

    t = replaceChildren(P, t, 'C:/p/src', toNodes(P, 'C:/p/src', [entry('lib', 'dir')]))
    expect(t.cursor).toBe('C:/p/src')
    expect(t.selected).toBe('')
    expect(t.expanded).toEqual(['C:/p/src', 'C:/p/src/lib'])

    t = replaceChildren(P, t, ROOT, [])
    expect(t.nodes).toEqual([])
    expect(t.expanded).toEqual([])
    expect(t.cursor).toBe('')
  })

  test('a folder that becomes a file loses its subtree', () => {
    let t = sample()
    t = replaceChildren(P, t, ROOT, toNodes(P, ROOT, [entry('src'), entry('b.md'), entry('.git', 'dir')]))
    expect(t.nodes.some(n => n.parent === 'C:/p/src')).toBe(false)
    expect(t.nodes.find(n => n.id === 'C:/p/src')?.kind).toBe('file')
  })

  test('markUnreadable keeps children and records the error', () => {
    const t = markUnreadable(sample(), 'C:/p/src', 'EACCES')
    expect(t.nodes.find(n => n.id === 'C:/p/src')?.error).toBe('EACCES')
    expect(t.nodes.some(n => n.id === 'C:/p/src/a.ts')).toBe(true)
    expect(replaceChildren(P, t, 'C:/p/src', []).nodes.find(n => n.id === 'C:/p/src')?.error).toBe(undefined)
  })
})

describe('navigate (keys table)', () => {
  const at = (t: TreeState, cursor: string) => ({ ...t, cursor })
  const move = (t: TreeState, key: string, shift?: boolean) => navigate(t, visibleRows(t), { key, ...(shift ? { shift } : {}) })

  test('movement keys, with an empty cursor landing on the first row', () => {
    const t = sample()
    expect(move(t, 'j').tree.cursor).toBe('C:/p/.git')
    expect(move(at(t, 'C:/p/.git'), 'down').tree.cursor).toBe('C:/p/src')
    expect(move(at(t, 'C:/p/src'), 'k').tree.cursor).toBe('C:/p/.git')
    expect(move(at(t, 'C:/p/.git'), 'up').tree.cursor).toBe('C:/p/.git')
    expect(move(at(t, 'C:/p/.git'), 'pagedown').tree.cursor).toBe('C:/p/b.md')
    expect(move(at(t, 'C:/p/b.md'), 'pageup').tree.cursor).toBe('C:/p/.git')
    expect(move(at(t, 'C:/p/src'), 'end').tree.cursor).toBe('C:/p/b.md')
    expect(move(at(t, 'C:/p/src'), 'home').tree.cursor).toBe('C:/p/.git')
  })

  test('every navigation resets the scroll to automatic (R5.4)', () => {
    expect(move({ ...sample(), scroll: 7 }, 'j').tree.scroll).toBe(null)
  })

  test('right and left', () => {
    const t = at(sample(), 'C:/p/src/lib')
    const opened = move(t, 'l')
    expect(opened.tree.expanded).toContain('C:/p/src/lib')
    expect(opened.effect).toEqual({ load: 'C:/p/src/lib' })
    expect(move(at(sample(), 'C:/p/src'), 'right').tree.expanded).toEqual(['C:/p/src'])
    expect(move(at(sample(), 'C:/p/src'), 'h').tree.expanded).toEqual([])
    expect(move(t, 'left').tree.cursor).toBe('C:/p/src')
    expect(move(at(sample(), 'C:/p/b.md'), 'h').tree.cursor).toBe('C:/p/b.md')
  })

  test('return and space toggle folders and select files', () => {
    expect(move(at(sample(), 'C:/p/src'), 'return').tree.expanded).toEqual([])
    expect(move(at(sample(), 'C:/p/src/a.ts'), 'space').tree.selected).toBe('C:/p/src/a.ts')
    expect(move(at(sample(), 'C:/p/src/a.ts'), ' ').tree.selected).toBe('C:/p/src/a.ts')
  })

  test('y and Y copy', () => {
    const t = at(sample(), 'C:/p/src/a.ts')
    expect(move(t, 'y').effect).toEqual({ copy: 'relative', id: 'C:/p/src/a.ts' })
    expect(move(t, 'Y').effect).toEqual({ copy: 'absolute', id: 'C:/p/src/a.ts' })
    expect(move(t, 'y', true).effect).toEqual({ copy: 'absolute', id: 'C:/p/src/a.ts' })
  })

  test('unknown keys change nothing (R9.1)', () => {
    const t = at({ ...sample(), scroll: 4 }, 'C:/p/src')
    expect(move(t, 'q').tree).toBe(t)
  })
})

describe('toggle, collapse and hidden', () => {
  test('toggle loads a folder only the first time', () => {
    const t = sample()
    expect(toggle(t, 'C:/p/src/lib').effect).toEqual({ load: 'C:/p/src/lib' })
    expect(toggle(t, 'C:/p/src').effect).toBe(undefined)
    expect(toggle(t, 'C:/p/b.md').tree).toBe(t)
  })

  test('collapseAll moves the cursor to its top-level ancestor', () => {
    const t = collapseAll(P, { ...sample(), cursor: 'C:/p/src/a.ts' })
    expect(t.expanded).toEqual([])
    expect(t.cursor).toBe('C:/p/src')
  })

  test('hiding moves a hidden cursor to a visible ancestor', () => {
    let t = replaceChildren(P, sample(), 'C:/p/.git', toNodes(P, 'C:/p/.git', [entry('HEAD')]))
    t = toggleHidden(P, { ...t, cursor: 'C:/p/.git/HEAD' })
    expect(t.showHidden).toBe(false)
    expect(t.cursor).toBe('')
    expect(toggleHidden(P, { ...sample(), cursor: 'C:/p/src/a.ts' }).cursor).toBe('C:/p/src/a.ts')
  })
})

describe('memory and window', () => {
  test('remember keeps recency, drops empties and holds at most 50 roots (R6.1, R6.3)', () => {
    let m = {}
    for (let i = 0; i < MEMORY_LIMIT + 1; i++) m = remember(m, `r${i}`, ['x'])
    expect(Object.keys(m)).toHaveLength(MEMORY_LIMIT)
    expect('r0' in m).toBe(false)
    m = remember(m, 'r1', ['y'])
    expect(Object.keys(m).at(-1)).toBe('r1')
    expect('r1' in remember(m, 'r1', [])).toBe(false)
  })

  test('windowOf centres the cursor in automatic mode and clamps a manual one (R5.2, R5.3)', () => {
    expect(windowOf(100, 50, 20, null)).toEqual({ from: 40, max: 80 })
    expect(windowOf(100, 2, 20, null)).toEqual({ from: 0, max: 80 })
    expect(windowOf(100, 99, 20, null)).toEqual({ from: 80, max: 80 })
    expect(windowOf(100, -1, 20, 200)).toEqual({ from: 80, max: 80 })
    expect(windowOf(3, 0, 20, null)).toEqual({ from: 0, max: 0 })
  })

  test('formatDate is YYYY-MM-DD HH:MM', () => {
    expect(formatDate(1_700_000_000_000)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  })
})
