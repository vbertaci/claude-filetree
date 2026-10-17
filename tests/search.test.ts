import type { FsEntry } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import type { TreeState } from '../types'
import { paths } from '../hooks/os'
import { filterOf, matches, parseFiles, termOf } from '../hooks/search'
import { emptyTree, replaceChildren, toNodes } from '../hooks/tree'

const P = paths('windows')
const ROOT = 'C:/p'

const entry = (name: string, kind: FsEntry['kind'] = 'file'): FsEntry => ({ name, kind, size: 1, mtimeMs: 5, isLink: false })

/** C:/p with src/ (lib/ (X.ts), a.ts) and lib.md, every folder loaded, none open. */
function sample(): TreeState {
  let t = emptyTree(ROOT, true)
  t = replaceChildren(P, t, ROOT, toNodes(P, ROOT, [entry('src', 'dir'), entry('lib.md')]))
  t = replaceChildren(P, t, 'C:/p/src', toNodes(P, 'C:/p/src', [entry('lib', 'dir'), entry('a.ts')]))
  return replaceChildren(P, t, 'C:/p/src/lib', toNodes(P, 'C:/p/src/lib', [entry('X.ts')]))
}

describe('termOf', () => {
  test('trims and lower-cases; only spaces is no search', () => {
    expect(termOf('  Parse ')).toBe('parse')
    expect(termOf('')).toBe('')
    expect(termOf('   ')).toBe('')
  })
})

describe('matches (R3)', () => {
  test('by the path relative to the root, with /, ignoring case, in index order', () => {
    const index = ['C:/p/src/lib/x.ts', 'C:/p/lib.md', 'C:/p/LIB/x.md']
    expect(matches(P, ROOT, index, 'lib/x')).toEqual(['C:/p/src/lib/x.ts', 'C:/p/LIB/x.md'])
    expect(matches(P, ROOT, index, 'p/')).toEqual([])
  })
})

describe('filterOf (R3.1, R3.3)', () => {
  test('null without a term', () => {
    expect(filterOf(P, sample(), '')).toBe(null)
  })

  test('the nodes that match and their ancestors, not the root', () => {
    expect([...filterOf(P, sample(), 'x.ts')!].sort()).toEqual(['C:/p/src', 'C:/p/src/lib', 'C:/p/src/lib/X.ts'])
    expect([...filterOf(P, sample(), 'lib')!].sort()).toEqual(['C:/p/lib.md', 'C:/p/src', 'C:/p/src/lib', 'C:/p/src/lib/X.ts'])
    expect(filterOf(P, sample(), 'zzz')!.size).toBe(0)
  })
})

describe('parseFiles (R2.2)', () => {
  test('ids under the root; a cut output loses its last path', () => {
    expect(parseFiles(P, ROOT, 'src/a.ts\0b c.md\0', false)).toEqual(['C:/p/src/a.ts', 'C:/p/b c.md'])
    expect(parseFiles(P, ROOT, 'src/a.ts\0b c.m', true)).toEqual(['C:/p/src/a.ts'])
    expect(parseFiles(P, ROOT, '', false)).toEqual([])
  })
})
