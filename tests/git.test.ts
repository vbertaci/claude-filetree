import { describe, expect, test } from 'claude-code/testing'

import type { FileNode, GitState } from '../types'
import {
  DIFF_ARGS,
  GIT_FLAGS,
  STATUS_ARGS,
  branchToneOf,
  chipsOf,
  emptyGit,
  gitArgv,
  gitCandidates,
  gitOf,
  gitOperationOf,
  isGitWatch,
  isSha,
  newlyStaged,
  parseBranch,
  parseNames,
  parsePrefix,
  parseNumstat,
  parseStatus,
  rollCounts,
  rollUp,
  sameRepo,
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

// ---- spec-04: git activity ----

const state = (over: Partial<GitState>): GitState => ({ ...emptyGit(), root: ROOT, top: ROOT, ...over })
const branch = (head: string, ahead = 0, behind = 0) => ({ head, upstream: 'origin/main', ahead, behind, detached: false, unborn: false })

describe('staged and sameRepo (spec-04 R2.6, R3.3)', () => {
  test('column X marks a staged change; untracked, ignored and conflicts are not staged', () => {
    const r = parseStatus(['## main', 'M  a.ts', ' M b.ts', 'A  c.ts', 'R  d.ts', 'old.ts', 'UU e.ts', 'AA f.ts', '?? g.ts', '!! h/', ''].join('\0'), CTX)
    expect(r.staged).toEqual(['C:/p/a.ts', 'C:/p/c.ts', 'C:/p/d.ts'])
  })

  test('the same repository: both reads of the current root, same top', () => {
    expect(sameRepo(state({}), state({}), ROOT)).toBe(true)
    expect(sameRepo(state({ top: '' }), state({ top: '' }), ROOT)).toBe(false)
    expect(sameRepo(state({}), state({ top: 'C:/other' }), ROOT)).toBe(false)
    expect(sameRepo(state({ root: 'C:/q' }), state({}), ROOT)).toBe(false)
    expect(sameRepo(emptyGit(), state({}), ROOT)).toBe(false)
  })
})

describe('gitCandidates and newlyStaged (spec-04 R2.1, R3.3)', () => {
  test('fresh: not dirty before, or deleted before; touched: dirty before; deletions are skipped', () => {
    const before = state({ changes: { 'C:/p/Old.ts': 'mod', 'C:/p/back.ts': 'del', 'C:/p/kept.ts': 'new' } })
    const after = state({ changes: { 'C:/p/new.ts': 'new', 'C:/p/old.ts': 'mod', 'C:/p/back.ts': 'new', 'C:/p/kept.ts': 'del' } })
    expect(gitCandidates(before, after, P)).toEqual({ fresh: ['C:/p/new.ts', 'C:/p/back.ts'], touched: ['C:/p/old.ts'] })
  })

  test('newly staged compares without case', () => {
    expect(newlyStaged(state({ staged: ['C:/p/A.ts'] }), state({ staged: ['C:/p/a.ts', 'C:/p/b.ts'] }), P)).toEqual(['C:/p/b.ts'])
  })
})

describe('sha, names and the engine record (spec-04 R3.1, R3.2, R7.2)', () => {
  test('isSha takes 7 to 64 hex characters, nothing that could be an option', () => {
    expect(isSha('a1b2c3d')).toBe(true)
    expect(isSha('A1B2C3D4E5F6')).toBe(true)
    expect(isSha('a1b2c3')).toBe(false)
    expect(isSha('--output=x')).toBe(false)
    expect(isSha('a1b2c3d HEAD')).toBe(false)
  })

  test('parseNames maps through the prefix and drops what is outside the root', () => {
    expect(parseNames(['src/a.ts', 'other/b.ts', ''].join('\0'), { paths: P, root: 'C:/p/src', prefix: 'src/' })).toEqual(['C:/p/src/a.ts'])
  })

  test('gitOperationOf reads the record defensively', () => {
    const op = { push: { branch: 'main' } }
    expect(gitOperationOf({ result: { stdout: '', gitOperation: op }, ref: 1, text: '' } as any)).toBe(op)
    expect(gitOperationOf({ result: 'text', ref: 1, text: '' } as any)).toBe(undefined)
    expect(gitOperationOf({ result: { gitOperation: 'x' }, ref: 1, text: '' } as any)).toBe(undefined)
    expect(gitOperationOf({ deny: 'no' } as any)).toBe(undefined)
  })
})

describe('chipsOf and branchToneOf (spec-04 R4.1, R4.7, R6.1)', () => {
  const b = state({ branch: branch('main', 1) })

  test('the table, in its order', () => {
    const op = {
      commit: { sha: 'a1b2c3d4e5', kind: 'committed' as const },
      branch: { ref: 'feature', action: 'merged' as const },
      push: { branch: 'main' },
      pr: { number: 12, action: 'created' as const },
    }
    const after = state({ branch: branch('dev') })
    expect(chipsOf(op, ['C:/p/x.ts'], b, after, true)).toEqual([
      { icon: '●', text: 'committed', detail: 'a1b2c3d', tone: 'commit' },
      { icon: '⑃', text: 'merged', detail: 'feature', tone: 'merge' },
      { icon: '↑', text: 'pushed', detail: 'main', tone: 'sync' },
      { icon: '⇄', text: 'opened PR #12', detail: '', tone: 'merge' },
      { icon: '⑂', text: 'switched to', detail: 'dev', tone: 'sync' },
    ])
  })

  test('staged only without a commit and in the same repository; amend and cherry-pick', () => {
    expect(chipsOf(undefined, ['C:/p/a', 'C:/p/b'], b, b, true)).toEqual([{ icon: '±', text: 'staged 2', detail: '', tone: 'commit' }])
    expect(chipsOf(undefined, ['C:/p/a'], b, b, false)).toEqual([])
    expect(chipsOf({ commit: { sha: 'abcdef12', kind: 'amended' } }, [], b, b, true)[0]).toEqual({ icon: '●', text: 'amended', detail: 'abcdef1', tone: 'commit' })
    expect(chipsOf({ commit: { sha: 'abcdef12', kind: 'cherry-picked' } }, [], b, b, true)[0]).toEqual({ icon: '⑃', text: 'cherry-picked', detail: 'abcdef1', tone: 'merge' })
  })

  test('PR texts', () => {
    const text = (action: string) => chipsOf({ pr: { number: 3, action } } as any, [], b, b, true)[0]?.text
    expect(text('merged')).toBe('merged PR #3')
    expect(text('commented')).toBe('commented on PR #3')
    expect(text('closed')).toBe('closed PR #3')
    expect(text('reopened')).toBe('reopened PR #3')
    expect(text('auto-merge-enabled')).toBe('PR #3 auto merge enabled')
  })

  test('no switch outside the same repository or without a branch', () => {
    expect(chipsOf(undefined, [], b, state({ branch: branch('dev') }), false)).toEqual([])
    expect(chipsOf(undefined, [], state({}), state({ branch: branch('dev') }), true)).toEqual([])
  })

  test('the tone: the last chip, else sync when ahead or behind moved on the same branch', () => {
    expect(branchToneOf([{ icon: '●', text: 'committed', detail: '', tone: 'commit' }], b, b, true)).toBe('commit')
    expect(branchToneOf([], b, state({ branch: branch('main', 0) }), true)).toBe('sync')
    expect(branchToneOf([], b, state({ branch: branch('main', 1, 1) }), true)).toBe('sync')
    expect(branchToneOf([], b, b, true)).toBe(null)
    expect(branchToneOf([], b, state({ branch: branch('main', 0) }), false)).toBe(null)
  })
})

describe('isGitWatch (spec-05 R2.4)', () => {
  test('the index and HEAD of a gitdir, a worktree one too, and nothing else', () => {
    expect(isGitWatch('C:\\p\\.git\\index')).toBe(true)
    expect(isGitWatch('C:/p/.git/HEAD')).toBe(true)
    expect(isGitWatch('C:\\p\\.git\\worktrees\\w\\index')).toBe(true)
    expect(isGitWatch('C:\\p\\index')).toBe(false)
    expect(isGitWatch('C:\\p\\.git\\config')).toBe(false)
    expect(isGitWatch('C:\\p\\.git\\refs\\heads\\main')).toBe(false)
    expect(isGitWatch('C:\\p\\src\\HEAD')).toBe(false)
  })
})
