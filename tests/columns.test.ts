import { describe, expect, test } from 'claude-code/testing'

import type { FileNode } from '../types'
import { cellText, columnOf, emptyColumns, formatAge, formatSize, modeOf, timeModeOf, widthOf } from '../hooks/columns'
import { formatDate } from '../hooks/tree'

const node = (kind: FileNode['kind'], size = 0, mtimeMs = 0): FileNode => ({
  id: `C:/p/${kind}`,
  parent: 'C:/p',
  name: kind,
  kind,
  hidden: false,
  mtimeMs,
  size,
  loaded: false,
})

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR

describe('the column mode (spec-07 R1)', () => {
  test('columnOf: date by default and for anything unknown', () => {
    expect(columnOf({})).toBe('date')
    expect(columnOf({ column: 'age' })).toBe('age')
    expect(columnOf({ column: 'size' })).toBe('size')
    expect(columnOf({ column: 'bytes' })).toBe('date')
  })

  test('timeModeOf: Σ goes back to the option, or to date when the option is size', () => {
    expect(timeModeOf('date')).toBe('date')
    expect(timeModeOf('age')).toBe('age')
    expect(timeModeOf('size')).toBe('date')
  })

  test('modeOf follows the Workflows table: Σ counts only under its root', () => {
    const at = (size: boolean | null, root = 'C:/p') => ({ root, size, bytes: {} })
    expect(modeOf(emptyColumns(), 'C:/p', 'date')).toBe('date')
    expect(modeOf(at(true), 'C:/p', 'date')).toBe('size')
    expect(modeOf(emptyColumns(), 'C:/p', 'age')).toBe('age')
    expect(modeOf(at(false), 'C:/p', 'age')).toBe('age')
    expect(modeOf(emptyColumns(), 'C:/p', 'size')).toBe('size')
    expect(modeOf(at(false), 'C:/p', 'size')).toBe('date')
    expect(modeOf(at(true, 'C:/q'), 'C:/p', 'date')).toBe('date')
    expect(modeOf(at(false, 'C:/q'), 'C:/p', 'size')).toBe('size')
  })

  test('widths: 16, 6 and 8', () => {
    expect([widthOf('date'), widthOf('age'), widthOf('size')]).toEqual([16, 6, 8])
  })
})

describe('formats (spec-07 Formatos)', () => {
  test('formatSize', () => {
    expect(formatSize(-1)).toBe('?')
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1023)).toBe('1023 B')
    expect(formatSize(1536)).toBe('1.5 K')
    expect(formatSize(12 * 1024 * 1024)).toBe('12.0 M')
    expect(formatSize(340 * 1024 ** 3)).toBe('340 G')
    expect(formatSize(5000 * 1024 ** 4)).toBe('5000 T')
  })

  test('formatAge', () => {
    const now = new Date(2026, 9, 17, 12, 0).getTime()
    expect(formatAge(0, now)).toBe('')
    expect(formatAge(now - 30_000, now)).toBe('now')
    expect(formatAge(now + 30_000, now)).toBe('now')
    expect(formatAge(now - 12 * MIN, now)).toBe('12m')
    expect(formatAge(now - 3 * HOUR, now)).toBe('3h')
    expect(formatAge(now - 5 * DAY, now)).toBe('5d')
    expect(formatAge(new Date(2026, 9, 9, 12, 0).getTime(), now)).toBe('Oct 9')
    expect(formatAge(new Date(2024, 2, 1).getTime(), now)).toBe('2024')
  })
})

describe('cellText (spec-07 R2.1–R2.3)', () => {
  const now = new Date(2026, 9, 17, 12, 0).getTime()
  const mtime = now - 3 * HOUR

  test('date: files only, as formatDate', () => {
    expect(cellText('date', node('file', 10, mtime), undefined, now)).toBe(formatDate(mtime))
    expect(cellText('date', node('dir'), 5, now)).toBe('')
    expect(cellText('date', node('link'), undefined, now)).toBe('')
  })

  test('age: files only', () => {
    expect(cellText('age', node('file', 10, mtime), undefined, now)).toBe('3h')
    expect(cellText('age', node('dir'), 5, now)).toBe('')
  })

  test('size: files by their bytes, folders by their measure, … before it, ? when unknown', () => {
    expect(cellText('size', node('file', 2048), undefined, now)).toBe('2.0 K')
    expect(cellText('size', node('dir'), undefined, now)).toBe('…')
    expect(cellText('size', node('dir'), 12_345, now)).toBe('12.1 K')
    expect(cellText('size', node('dir'), -1, now)).toBe('?')
    expect(cellText('size', node('link'), undefined, now)).toBe('')
    expect(cellText('size', node('other'), undefined, now)).toBe('')
  })
})
