import { describe, expect, test } from 'claude-code/testing'

import type { FileNode, GitState } from '../types'
import {
  DIFF_ARGS,
  GIT_FLAGS,
  STATUS_ARGS,
  emptyGit,
  gitArgv,
  gitOf,
  parseBranch,
  parsePrefix,
  parseNumstat,
  parseStatus,
  rollCounts,
  rollUp,
  stronger,
} from '../hooks/git'
import { executable, paths } from '../hooks/os'

const P = paths('windows')
const ROOT = 'C:/p'
const CTX = { paths: P, root: ROOT, prefix: '' }

const node = (id: string, kind: FileNode['kind'] = 'file'): FileNode => ({
  id,
  parent: P.parent(id)!,
  name: P.base(id),
  kind,
  hidden: false,
  mtimeMs: 0,
  loaded: kind === 'dir',
})

describe('executable and argv (R1)', () => {
  test('git.exe on Windows, git elsewhere', () => {
    expect(executable('git', 'windows')).toBe('git.exe')
    expect(executable('git', 'posix')).toBe('git')
  })

  test('fixed flags, the root only as the value of -C, then the subcommand', () => {
    expect(gitArgv('git.exe', P, 'C:/Users/me/repo', 'status', STATUS_ARGS)).toEqual([
      'git.exe',
      '--no-optional-locks',
      '-c',
      'core.fsmonitor=false',
      '-C',
      'C:\\Users\\me\\repo',
      'status',
      '--porcelain=v1',
      '-b',
      '-z',
      '--ignored=traditional',
      '--untracked-files=normal',
      '--',
      '.',
    ])
    expect(GIT_FLAGS).toEqual(['--no-optional-locks', '-c', 'core.fsmonitor=false'])
    expect(DIFF_ARGS).toContain('--no-ext-diff')
    expect(DIFF_ARGS).toContain('--no-textconv')
    expect(DIFF_ARGS.indexOf('--')).toBe(DIFF_ARGS.length - 2)
  })
})

describe('parsePrefix (R2.1)', () => {
  test('the prefix line, then the top; an empty prefix at the top; null without a top', () => {
    expect(parsePrefix('src/\r\nC:/p\r\n', P)).toEqual({ prefix: 'src/', top: 'C:/p' })
    expect(parsePrefix('\nc:/p\n', P)).toEqual({ prefix: '', top: 'C:/p' })
    expect(parsePrefix('', P)).toBe(null)
  })
})

describe('parseBranch', () => {
  test('each header form', () => {
    expect(parseBranch('## main')).toEqual({ head: 'main', upstream: '', ahead: 0, behind: 0, detached: false, unborn: false })
    expect(parseBranch('## main...origin/main [ahead 1, behind 2]')).toEqual({ head: 'main', upstream: 'origin/main', ahead: 1, behind: 2, detached: false, unborn: false })
    expect(parseBranch('## main...origin/main [gone]')).toEqual({ head: 'main', upstream: 'origin/main', ahead: 0, behind: 0, detached: false, unborn: false })
    expect(parseBranch('## HEAD (no branch)')).toEqual({ head: 'detached', upstream: '', ahead: 0, behind: 0, detached: true, unborn: false })
    expect(parseBranch('## No commits yet on main')).toEqual({ head: 'main', upstream: '', ahead: 0, behind: 0, detached: false, unborn: true })
  })
})

describe('parseStatus (R3.2–R3.6)', () => {
  const sample = [
    '## main...origin/main [ahead 1, behind 2]',
    'M  src/staged.ts',
    ' M src/a/work.ts',
    'A  new.ts',
    'AM both.ts',
    'D  gone.ts',
    'R  src/moved.ts',
    'src/old.ts',
    'UU clash.ts',
    '?? fresh/',
    '?? loose.txt',
    '!! dist/',
    '',
  ].join('\0')

  test('letters, changes, ignored, untracked and the branch', () => {
    const r = parseStatus(sample, CTX)
    expect(r.branch?.head).toBe('main')
    expect(r.changes).toEqual({
      'C:/p/src/staged.ts': 'mod',
      'C:/p/src/a/work.ts': 'mod',
      'C:/p/new.ts': 'new',
      'C:/p/both.ts': 'new',
      'C:/p/gone.ts': 'del',
      'C:/p/src/moved.ts': 'mod',
      'C:/p/clash.ts': 'mod',
      'C:/p/loose.txt': 'new',
    })
    expect(r.ignored).toEqual(['C:/p/dist'])
    expect(r.untracked).toEqual(['C:/p/fresh'])
    expect(r.status['c:/p/both.ts']).toBe('M')
    expect(r.status['c:/p/src/moved.ts']).toBe('R')
    expect(r.status['c:/p/clash.ts']).toBe('U')
    expect(r.status['c:/p/fresh']).toBe('?')
    expect(r.status['c:/p/dist']).toBe(undefined)
    // The old path of a rename is skipped, not read as a record.
    expect(r.status['c:/p/src/old.ts']).toBe(undefined)
  })

  test('folders and the root take the strongest letter below them', () => {
    const r = parseStatus(sample, CTX)
    expect(r.status['c:/p/src/a']).toBe('M')
    expect(r.status['c:/p/src']).toBe('M')
    expect(r.status['c:/p']).toBe('U')
    expect(stronger('M', 'D')).toBe('D')
    expect(stronger('D', '?')).toBe('D')
    expect(stronger(undefined, 'A')).toBe('A')
  })

  test('with a prefix, paths outside it are dropped and the rest land under the root', () => {
    const r = parseStatus(['## main', ' M src/x.ts', ' M other/y.ts', ''].join('\0'), { paths: P, root: 'C:/p/src', prefix: 'src/' })
    expect(r.changes).toEqual({ 'C:/p/src/x.ts': 'mod' })
    expect(r.status['c:/p/src']).toBe('M')
  })

  test('a record cut off at the end is dropped', () => {
    const r = parseStatus(['## main', ' M a.ts', ' M b.t'].join('\0'), CTX)
    expect(Object.keys(r.changes)).toEqual(['C:/p/a.ts'])
  })
})

describe('parseNumstat, rollUp and rollCounts (R3.7–R3.9)', () => {
  test('added and removed per file; a binary counts 0; a rename keeps the new path', () => {
    const out = ['3\t1\tsrc/a.ts', '-\t-\tlogo.png', '2\t0\t', 'src/old.ts', 'src/new.ts', ''].join('\0')
    expect(parseNumstat(out, CTX)).toEqual({ 'c:/p/src/a.ts': [3, 1], 'c:/p/logo.png': [0, 0], 'c:/p/src/new.ts': [2, 0] })
  })

  test('rollUp adds each pair up to the root; rollCounts counts new, mod and del per folder', () => {
    const diff = rollUp({ 'c:/p/src/a/x.ts': [3, 1], 'c:/p/src/y.ts': [1, 1] }, CTX)
    expect(diff['c:/p/src/a']).toEqual([3, 1])
    expect(diff['c:/p/src']).toEqual([4, 2])
    expect(diff['c:/p']).toEqual([4, 2])
    expect(diff['c:/p/src/a/x.ts']).toEqual([3, 1])
    const counts = rollCounts({ 'C:/p/src/a/x.ts': 'new', 'C:/p/src/y.ts': 'mod', 'C:/p/z.ts': 'del' }, CTX)
    expect(counts['c:/p/src/a']).toEqual([1, 0, 0])
    expect(counts['c:/p/src']).toEqual([1, 1, 0])
    expect(counts['c:/p']).toEqual([1, 1, 1])
  })
})

describe('gitOf (R3.5, R3.6, R5)', () => {
  const g: GitState = {
    ...emptyGit(),
    root: ROOT,
    top: ROOT,
    status: { 'c:/p/readme.md': 'M', 'c:/p/fresh': '?', 'c:/p/src': 'M' },
    diff: { 'c:/p/readme.md': [2, 1] },
    counts: { 'c:/p/src': [0, 1, 0] },
    ignored: ['C:/p/dist'],
    untracked: ['C:/p/fresh'],
  }

  test('its own letter, matched without case; diff on files, counts on folders', () => {
    expect(gitOf(g, P, node('C:/p/Readme.md'))).toEqual({ letter: 'M', ignored: false, diff: [2, 1] })
    expect(gitOf(g, P, node('C:/p/src', 'dir'))).toEqual({ letter: 'M', ignored: false, counts: [0, 1, 0] })
  })

  test('? under an untracked folder; ignored under an ignored one; nothing otherwise', () => {
    expect(gitOf(g, P, node('C:/p/fresh/deep/a.ts'))).toEqual({ letter: '?', ignored: false })
    expect(gitOf(g, P, node('C:/p/dist/app.js'))).toEqual({ ignored: true })
    expect(gitOf(g, P, node('C:/p/dist', 'dir'))).toEqual({ ignored: true })
    expect(gitOf(g, P, node('C:/p/clean.ts'))).toEqual({ ignored: false })
  })
})
