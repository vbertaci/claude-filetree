import { describe, expect, test } from 'claude-code/testing'

import type { TouchedState } from '../types'
import { paths } from '../hooks/os'
import { layoutTouched } from '../hooks/pane'
import { READ_ID, TOUCHED_LIMIT, WRITTEN_ID, clean, countsAsRead, emptyTouched, forget, listedIds, navigateTouched, record } from '../hooks/touched'
import { W } from './world'

// spec-10: the lists of files Claude changed and read, and how their rows are laid out.

const win = paths('windows')
const lists = (written: string[], read: string[], extra: Partial<TouchedState> = {}): TouchedState => ({ ...emptyTouched(), written, read, ...extra })
const look = { root: 'C:/p', home: 'C:/Users/w4rl0ck', glyphs: 'plain' as const, glow: null, selected: '' }
const text = (row: { segs: { text: string }[] }) => row.segs.map(s => s.text).join('')

describe('the lists (spec-10 R2)', () => {
  test('emptyTouched: the tree shows and nothing is listed', () => {
    expect(emptyTouched()).toEqual({ show: false, written: [], read: [], cursor: '', scroll: null })
  })

  test('countsAsRead: Read and Grep, not Glob (R2.1)', () => {
    expect(countsAsRead('Read')).toBe(true)
    expect(countsAsRead('Grep')).toBe(true)
    expect(countsAsRead('Glob')).toBe(false)
    expect(countsAsRead('Edit')).toBe(false)
  })

  test('record: latest first, each file once, any case on Windows (R2.2)', () => {
    let s = record(emptyTouched(), win, 'read', ['C:/p/a.ts', 'C:/p/b.ts', 'c:/P/A.TS'])
    expect(s.read).toEqual(['C:/p/a.ts', 'C:/p/b.ts'])
    s = record(s, win, 'read', ['C:/p/b.ts'])
    expect(s.read).toEqual(['C:/p/b.ts', 'C:/p/a.ts'])
    s = record(s, win, 'write', ['C:/p/x.ts', 'C:/p/y.ts'])
    s = record(s, win, 'write', ['C:/p/y.ts'])
    expect(s.written).toEqual(['C:/p/y.ts', 'C:/p/x.ts'])
  })

  test('record: a changed file leaves the read list; a read of a changed file changes nothing (R2.3, R2.4)', () => {
    let s = record(emptyTouched(), win, 'read', ['C:/p/a.ts', 'C:/p/b.ts'])
    s = record(s, win, 'write', ['C:/p/a.ts'])
    expect(s).toMatchObject({ written: ['C:/p/a.ts'], read: ['C:/p/b.ts'] })
    expect(record(s, win, 'read', ['C:/p/A.ts'])).toBe(s)
    expect(record(s, win, 'read', [])).toBe(s)
    expect(record(s, win, 'write', [])).toBe(s)
  })

  test('record: each list keeps at most TOUCHED_LIMIT, the oldest dropped (R2.5)', () => {
    const many = Array.from({ length: TOUCHED_LIMIT + 5 }, (_, i) => `C:/p/f${i}.ts`)
    const reads = record(emptyTouched(), win, 'read', many)
    expect(reads.read).toHaveLength(TOUCHED_LIMIT)
    expect(reads.read.at(-1)).toBe(`C:/p/f${TOUCHED_LIMIT - 1}.ts`)
    const s = record(reads, win, 'write', many)
    expect(s.written).toHaveLength(TOUCHED_LIMIT)
    expect(s.written[0]).toBe('C:/p/f0.ts')
    expect(s.read).toEqual([])
  })

  test('record keeps the view, the cursor and the window', () => {
    const s = record(lists([], [], { show: true, cursor: 'C:/p/a.ts', scroll: 3 }), win, 'write', ['C:/p/a.ts'])
    expect(s).toMatchObject({ show: true, cursor: 'C:/p/a.ts', scroll: 3 })
  })

  test('listedIds: changed, then read', () => {
    expect(listedIds(lists(['C:/p/w.ts'], ['C:/p/r.ts']))).toEqual(['C:/p/w.ts', 'C:/p/r.ts'])
  })

  test('forget: the file leaves its list; the cursor on it moves to the next row, else the one before (R4.1)', () => {
    const s = lists(['C:/p/w1', 'C:/p/w2'], ['C:/p/r1'], { cursor: 'C:/p/w2' })
    const a = forget(s, win, 'c:/P/W2')
    expect(a).toMatchObject({ written: ['C:/p/w1'], read: ['C:/p/r1'], cursor: 'C:/p/r1' })
    const b = forget(a, win, 'C:/p/r1')
    expect(b).toMatchObject({ written: ['C:/p/w1'], read: [], cursor: 'C:/p/w1' })
    expect(forget(b, win, 'C:/p/w1').cursor).toBe('')
    // Another file's cursor stays; an unlisted id changes nothing.
    expect(forget(s, win, 'C:/p/r1').cursor).toBe('C:/p/w2')
    expect(forget(s, win, 'C:/p/nope')).toBe(s)
  })

  test('clean: both lists empty, the view stays (R5.1)', () => {
    expect(clean(lists(['C:/p/a'], ['C:/p/b'], { show: true, cursor: 'C:/p/a', scroll: 2 }))).toEqual({
      show: true,
      written: [],
      read: [],
      cursor: '',
      scroll: null,
    })
  })
})

describe('keys (spec-10 R4.3)', () => {
  const s = lists(['C:/p/w1', 'C:/p/w2'], ['C:/p/r1'])

  test('moves over the files of both lists, the titles skipped; the window goes automatic', () => {
    let t = navigateTouched({ ...s, scroll: 4 }, { key: 'j' }).touched
    expect(t).toMatchObject({ cursor: 'C:/p/w1', scroll: null })
    t = navigateTouched(navigateTouched(t, { key: 'down' }).touched, { key: 'j' }).touched
    expect(t.cursor).toBe('C:/p/r1')
    expect(navigateTouched(t, { key: 'j' }).touched.cursor).toBe('C:/p/r1')
    expect(navigateTouched(t, { key: 'k' }).touched.cursor).toBe('C:/p/w2')
    expect(navigateTouched(t, { key: 'home' }).touched.cursor).toBe('C:/p/w1')
    expect(navigateTouched({ ...t, cursor: 'C:/p/w1' }, { key: 'end' }).touched.cursor).toBe('C:/p/r1')
    expect(navigateTouched({ ...t, cursor: 'C:/p/w1' }, { key: 'pagedown' }).touched.cursor).toBe('C:/p/r1')
  })

  test('Enter opens the cursor file; y and Y copy it; nothing without a cursor', () => {
    const at = { ...s, cursor: 'C:/p/w2' }
    expect(navigateTouched(at, { key: 'return' }).effect).toEqual({ open: 'C:/p/w2' })
    expect(navigateTouched(at, { key: 'y' }).effect).toEqual({ copy: 'relative', id: 'C:/p/w2' })
    expect(navigateTouched(at, { key: 'Y' }).effect).toEqual({ copy: 'absolute', id: 'C:/p/w2' })
    expect(navigateTouched(s, { key: 'return' })).toEqual({ touched: s })
    expect(navigateTouched(at, { key: 'x' })).toEqual({ touched: at })
  })

  test('empty lists: the moves leave no cursor', () => {
    expect(navigateTouched(emptyTouched(), { key: 'j' }).touched.cursor).toBe('')
  })
})

describe('layout (spec-10 R3)', () => {
  test('changed on top, read below, each under its title with the count; the cursor row is active', () => {
    const s = lists(['C:/p/src/a.ts', 'C:/p/b.md'], ['C:/p/src/lib/x.ts'], { cursor: 'C:/p/b.md' })
    const { props } = layoutTouched(s, { surface: 'terminal', bodyColumns: 40, bodyRows: 20 }, win, look, false)
    expect(props.rows.map(r => r.id)).toEqual([WRITTEN_ID, 'C:/p/src/a.ts', 'C:/p/b.md', READ_ID, 'C:/p/src/lib/x.ts'])
    expect(props.rows.map(r => text(r).trimEnd())).toEqual(['changed 2', '  · a.ts src', '  · b.md', 'read 1', `  · x.ts ${W('src/lib')}`])
    expect(props.rows.map(r => r.active)).toEqual([false, false, true, false, false])
    expect(props.rows.every(r => text(r).length === 40)).toBe(true)
    // Changed names take the write color, read names the read color; the titles are bold.
    expect(props.rows[1]!.segs[1]).toEqual({ text: 'a.ts', color: 'claude' })
    expect(props.rows[4]!.segs[1]).toEqual({ text: 'x.ts', color: 'autoAccept' })
    expect(props.rows[0]!.segs[0]).toEqual({ text: 'changed', color: 'claude', bold: true })
    expect(props.empty).toBe(null)
  })

  test('a list with nothing has no title; both empty say so', () => {
    const only = layoutTouched(lists([], ['C:/p/a']), { surface: 'terminal', bodyColumns: 30, bodyRows: 20 }, win, look, false)
    expect(only.props.rows.map(r => r.id)).toEqual([READ_ID, 'C:/p/a'])
    const none = layoutTouched(emptyTouched(), { surface: 'desktop', bodyColumns: 30, bodyRows: 20 }, win, look, false)
    expect(none.props).toEqual({ rows: [], bar: null, empty: 'nothing read or changed yet', more: 0 })
  })

  test('outside the root the folder is spelled in full; a long folder gives way from its start', () => {
    const s = lists(['C:/Users/w4rl0ck/notes/n.md', 'C:/p/very/long/folder/name/f.ts'], [])
    const { props } = layoutTouched(s, { surface: 'terminal', bodyColumns: 24, bodyRows: 20 }, win, look, false)
    expect(text(props.rows[1]!).trimEnd()).toBe(`  · n.md ${W('~/notes')}`)
    expect(text(props.rows[2]!)).toBe(`  · f.ts …${W('ng/folder/name')}`)
  })

  test('a long name is cut and the folder goes', () => {
    const s = lists(['C:/p/src/a-very-long-file-name.ts'], [])
    const { props } = layoutTouched(s, { surface: 'terminal', bodyColumns: 16, bodyRows: 20 }, win, look, false)
    expect(text(props.rows[1]!)).toBe('  · a-very-long…')
  })

  test('the selected file is bold; a lit file glows in its tone', () => {
    const s = lists(['C:/p/a.ts', 'C:/p/b.ts'], [])
    const glow = { lit: { 'C:/p/b.ts': { tone: 'write' as const } }, focus: 'C:/p/b.ts' }
    const { props } = layoutTouched(s, { surface: 'desktop', bodyColumns: 30, bodyRows: 20 }, win, { ...look, glow, selected: 'C:/p/a.ts' }, false)
    expect(props.rows[1]!.segs[1]).toEqual({ text: 'a.ts', color: 'claude', bold: true })
    expect(props.rows[2]!.segs[1]).toEqual({ text: 'b.ts', color: 'claude', glow: 'bright' })
  })

  test('the terminal gets a window around the cursor with a bar; the desktop gets every row', () => {
    const many = Array.from({ length: 30 }, (_, i) => `C:/p/f${i}.ts`)
    const s = lists(many, [], { cursor: 'C:/p/f20.ts' })
    const term = layoutTouched(s, { surface: 'terminal', bodyColumns: 30, bodyRows: 12 }, win, look, true)
    // 12 rows less the header, the nav row and the footer.
    expect(term.room).toBe(9)
    expect(term.props.rows).toHaveLength(9)
    expect(term.props.rows.map(r => r.id)).toContain('C:/p/f20.ts')
    expect(term.props.bar).not.toBe(null)
    expect(term.max).toBe(31 - 9)
    expect(text(term.props.rows[0]!)).toHaveLength(29)
    const desk = layoutTouched(s, { surface: 'desktop', bodyColumns: 30, bodyRows: 12 }, win, look, true)
    expect(desk.props.rows).toHaveLength(31)
    expect(desk.props.bar).toBe(null)
  })
})
