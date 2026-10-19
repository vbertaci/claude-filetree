import { describe, expect, test } from 'claude-code/testing'

import { paths } from '../hooks/os'
import { appended, mentionOf, referenceOf, selectionOf } from '../hooks/selection'

const win = paths('windows')

describe('selection (spec-09)', () => {
  test('selectionOf: mention by default and for anything unknown (R1.1)', () => {
    expect(selectionOf({})).toBe('mention')
    expect(selectionOf({ selection: 'append' })).toBe('append')
    expect(selectionOf({ selection: 'off' })).toBe('off')
    expect(selectionOf({ selection: 'context' })).toBe('mention')
  })

  test('referenceOf: relative to the cwd inside it, absolute outside, always with /', () => {
    expect(referenceOf(win, 'C:/p', 'C:/p/src/a.ts')).toBe('src/a.ts')
    expect(referenceOf(win, 'C:/p', 'c:\\P\\src')).toBe('src')
    expect(referenceOf(win, 'C:/p', 'C:/q/x.txt')).toBe('C:/q/x.txt')
    expect(referenceOf(win, 'C:/p', 'C:/p')).toBe('C:/p')
    expect(referenceOf(win, 'C:/p', 'C:/px/a')).toBe('C:/px/a')
  })

  test('mentionOf: quoted when the path has white space (R2.1)', () => {
    expect(mentionOf('src/a.ts')).toBe('@src/a.ts')
    expect(mentionOf('my docs/a b.md')).toBe('@"my docs/a b.md"')
    expect(mentionOf('a\tb')).toBe('@"a\tb"')
  })

  test('appended: the line at the end, unless the prompt already names the file, any case (R3.1)', () => {
    expect(appended('explain this', 'src/a.ts')).toBe('explain this\n\n(selected in the file tree: src/a.ts)')
    expect(appended('what is in SRC/A.TS?', 'src/a.ts')).toBe(null)
    expect(appended('see @src/a.ts', 'src/a.ts')).toBe(null)
  })
})