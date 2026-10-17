import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { GitChip, GitLetter, GitState, Glow, RowSpec, RowsProps, Seg, ThemeKeyName, Tone, TreeState } from '../types'
import { BRANCH_ID, type NodeGit, gitOf } from './git'
import type { Paths } from './os'
import { type Row, formatDate, visibleRows, windowOf } from './tree'

export const DESKTOP_ROW_CAP = 1500
/**
 * Serialized RowSpec characters the desktop sends. Both the Client's props and the tree it draws
 * must stay under 100,000 characters, and the drawn tree runs about 1.5 times the props.
 */
export const DESKTOP_CHAR_BUDGET = 45_000
const DATE_WIDTH = 16
const MIN_NAME = 12

/** What glows while a glow is live; `focus` is null when follow is off. */
export type GlowView = { lit: Record<string, Glow>; focus: string | null } | null

/** What the render knows of git; null before the first read of the current root (spec-03 R7.3). */
export type GitView = { state: GitState; hints: boolean } | null

/** The row under the header: the branch inside a repository, the hint outside one. */
export type Extra = 'branch' | 'hint' | null

export type Layout = {
  rows: Row[]
  from: number
  max: number
  room: number
  extra: Extra
  props: RowsProps
}

/** Each returns the work it started, so a press settles once that work has. */
export type PaneActions = {
  up: () => Promise<unknown>
  cwd: () => Promise<unknown>
  refresh: () => Promise<unknown>
  hidden: () => Promise<unknown>
  collapse: () => Promise<unknown>
  unselect: () => Promise<unknown>
  nav: (key: 'down' | 'up' | 'left' | 'right' | 'return') => Promise<unknown>
}

const GLYPH = { dir: '■', file: '·', link: '↪', other: '◇' } as const

const LETTER_COLOR: Record<GitLetter, ThemeKeyName> = {
  '?': 'success',
  A: 'success',
  M: 'warning',
  T: 'warning',
  R: 'suggestion',
  C: 'suggestion',
  D: 'error',
  U: 'error',
}

const TONE_COLOR: Record<Tone, ThemeKeyName> = {
  read: 'autoAccept',
  write: 'claude',
  commit: 'success',
  sync: 'suggestion',
  merge: 'merged',
}

/** A row's git suffixes: `loc` takes the date's place, `cell` closes the row (spec-03 R5.4, R5.5). */
type Cells = { git: NodeGit | null; loc: Seg[]; cell: Seg[] }

const NO_CELLS: Cells = { git: null, loc: [], cell: [] }

const width = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + s.text.length, 0)

export function rootLabel(paths: Paths, root: string): string {
  return paths.parent(root) === null ? paths.native(root) : paths.base(root)
}

function countSegs(c: [number, number, number] | undefined): Seg[] {
  if (!c) return []
  return [
    ...(c[0] > 0 ? [{ text: ` ?:${c[0]}`, color: 'success' as const }] : []),
    ...(c[1] > 0 ? [{ text: ` M:${c[1]}`, color: 'warning' as const }] : []),
    ...(c[2] > 0 ? [{ text: ` D:${c[2]}`, color: 'error' as const }] : []),
  ]
}

function gitCells(row: Row, g: NodeGit): Cells {
  const loc: Seg[] = []
  if (row.node.kind === 'file' && g.diff) {
    if (g.diff[0] > 0) loc.push({ text: ` +${g.diff[0]}`, color: 'success' })
    if (g.diff[1] > 0) loc.push({ text: ` -${g.diff[1]}`, color: 'error' })
  }
  const counts = row.node.kind === 'dir' ? countSegs(g.counts) : []
  let cell: Seg[]
  if (counts.length > 0) cell = counts
  else if (g.letter) cell = [{ text: ` ${g.letter}`, color: LETTER_COLOR[g.letter], bold: true }]
  else if (g.ignored) cell = [{ text: ' ⊘', color: 'subtle' }]
  else cell = [{ text: '  ' }]
  return { git: g, loc, cell }
}

function fixedWidth(row: Row, bar: number, cells: Cells): number {
  const suffix = row.node.error ? ' (unreadable)' : ''
  return row.depth * 2 + 2 + 2 + bar + suffix.length + width(cells.cell)
}

/** The narrowest name the date column leaves; files with `+a -d` show no date. */
function showsDate(rows: readonly Row[], cellsOf: (r: Row) => Cells, bar: number, total: number): boolean {
  const dated = rows.filter(r => r.node.kind === 'file' && cellsOf(r).loc.length === 0)
  return Math.min(...dated.map(r => total - fixedWidth(r, bar, cellsOf(r)) - DATE_WIDTH - 1)) >= MIN_NAME
}

function rowSpec(row: Row, t: TreeState, total: number, bar: number, showDate: boolean, glow: GlowView, cells: Cells): RowSpec {
  const { node } = row
  const fixed = fixedWidth(row, bar, cells)
  const loc = width(cells.loc)
  const dated = showDate && node.kind === 'file' && loc === 0
  const budget = Math.max(1, total - fixed - (loc > 0 ? loc : dated ? DATE_WIDTH + 1 : 0))
  const name = node.name.length > budget ? `${node.name.slice(0, budget - 1)}…` : node.name
  const isSelected = node.id === t.selected

  const used = fixed - bar + name.length
  const date = dated ? formatDate(node.mtimeMs) : ''
  const pad = ' '.repeat(Math.max(dated ? 1 : 0, total - bar - used - date.length - loc))
  const indent = '  '.repeat(row.depth)
  const caret = node.kind === 'dir' ? (row.isOpen ? '▾ ' : '▸ ') : '  '
  const glyph = `${GLYPH[node.kind]} `

  // Spaces take the style of the segment they join, so a row is as few segments as its colors.
  const segs: Seg[] =
    node.kind === 'dir'
      ? [{ text: indent + caret, color: 'subtle' }, { text: glyph, color: 'suggestion' }]
      : [{ text: indent + caret + glyph, color: 'subtle' }]
  const g = cells.git
  const plainColor: ThemeKeyName = node.hidden ? 'subtle' : 'text'
  const color: ThemeKeyName = g?.letter ? LETTER_COLOR[g.letter] : g?.ignored ? 'subtle' : plainColor
  const strike = g?.letter === 'D' && node.kind === 'file'
  const nameStyle = { color, ...(isSelected ? { bold: true as const } : {}), ...(strike ? { strike: true as const } : {}) }
  const lit = glow?.lit[node.id]
  if (lit) {
    // A lit name is a segment of its own, so the Client can run the band over it alone (spec-02 R5.3).
    segs.push({ text: name, color: TONE_COLOR[lit.tone], glow: lit.faint ? 'faint' : 'bright' })
    if (node.error) segs.push({ text: ` (unreadable)${pad}`, color: 'error' })
    else if (pad !== '') segs.push({ text: pad, color })
  } else if (node.error) segs.push({ text: name, ...nameStyle }, { text: ` (unreadable)${pad}`, color: 'error' })
  // A struck name keeps its line off the padding.
  else if (strike) segs.push({ text: name, ...nameStyle }, ...(pad !== '' ? [{ text: pad, color }] : []))
  else segs.push({ text: name + pad, ...nameStyle })
  if (dated) segs.push({ text: date, color: 'subtle' })
  segs.push(...cells.loc, ...cells.cell)
  return { id: node.id, segs, active: node.id === t.cursor }
}

function extraOf(git: GitView): Extra {
  if (git === null) return null
  if (git.state.top !== '') return git.state.branch !== null ? 'branch' : null
  return git.hints ? 'hint' : null
}

/** Which rows the Client gets, and the window they come from (spec-01 R4, R5). */
export function layoutPane(
  t: TreeState,
  view: { surface: string; bodyColumns: number; bodyRows: number },
  glow: GlowView,
  git: GitView,
  paths: Paths,
  chip: GitChip | null,
): Layout {
  const rows = visibleRows(t)
  const total = Math.max(1, view.bodyColumns)
  const extra = extraOf(git)
  const repo = git !== null && git.state.top !== '' ? git.state : null
  const cache = new Map<string, Cells>()
  const cellsOf = (r: Row): Cells => {
    if (repo === null) return NO_CELLS
    let cells = cache.get(r.id)
    if (!cells) {
      cells = gitCells(r, gitOf(repo, paths, r.node))
      cache.set(r.id, cells)
    }
    return cells
  }

  if (view.surface !== 'terminal') {
    const candidates = rows.slice(0, DESKTOP_ROW_CAP)
    const showDate = showsDate(candidates, cellsOf, 0, total)
    // Whichever comes first: the row cap or the character budget of the Client's props.
    const specs: RowSpec[] = []
    let chars = 0
    for (const r of candidates) {
      const spec = rowSpec(r, t, total, 0, showDate, glow, cellsOf(r))
      chars += JSON.stringify(spec).length + 1
      if (chars > DESKTOP_CHAR_BUDGET) break
      specs.push(spec)
    }
    return {
      rows,
      from: 0,
      max: 0,
      room: rows.length,
      extra,
      props: {
        rows: specs,
        bar: null,
        empty: rows.length === 0 ? 'empty' : null,
        more: rows.length - specs.length,
      },
    }
  }

  const footer = t.selected !== '' || chip !== null
  const fixedRows = 2 + (extra !== null ? 1 : 0) + (footer ? 1 : 0)
  const room = Math.max(5, view.bodyRows - fixedRows)
  // While following, the automatic window centres on what Claude touched, if it is in view (spec-02 R7.1).
  const focusIndex = glow?.focus ? rows.findIndex(r => r.id === glow.focus) : -1
  const cursorIndex = focusIndex >= 0 ? focusIndex : rows.findIndex(r => r.id === t.cursor)
  const { from, max } = windowOf(rows.length, cursorIndex, room, t.scroll)
  const shown = rows.slice(from, from + room)
  const bar = rows.length > room ? 1 : 0
  const showDate = showsDate(shown, cellsOf, bar, total)
  const thumbSize = Math.max(1, Math.round((room * room) / Math.max(1, rows.length)))
  return {
    rows,
    from,
    max,
    room,
    extra,
    props: {
      rows: shown.map(r => rowSpec(r, t, total, bar, showDate, glow, cellsOf(r))),
      bar: bar ? { thumbFrom: max === 0 ? 0 : Math.round((from / max) * (room - thumbSize)), thumbSize } : null,
      empty: rows.length === 0 ? 'empty' : null,
      more: 0,
    },
  }
}

export function renderPane(
  $: EngineInterface,
  e: RenderInput<'Pane', 'terminal' | 'desktop'>,
  paths: Paths,
  t: TreeState,
  layout: Layout,
  git: GitView,
  glow: GlowView,
  chip: GitChip | null,
  actions: PaneActions,
): RenderElement {
  const { Box, Text, Button, Client } = $.ui.resolve(e)
  const terminal = e.surface === 'terminal'

  // The branch and the root's totals; the upstream is the first thing cut (spec-03 R6).
  const branchRow = () => {
    const b = git?.state.branch
    if (!git || !b) return null
    const rootKey = paths.key(t.root)
    const [added, removed] = git.state.diff[rootKey] ?? [0, 0]
    const counts = countSegs(git.state.counts[rootKey])
    // While the branch row glows, the glyph and the name take the action's tone (spec-04 R6.4).
    const lit = glow?.lit[BRANCH_ID]
    return (
      <Box flexDirection="row">
        <Box flexDirection="row" flexShrink={0}>
          <Text color={lit ? TONE_COLOR[lit.tone] : 'suggestion'} {...(lit ? { weight: 'bold' as const } : {})}>
            ⑂{' '}
          </Text>
          <Text color={lit ? TONE_COLOR[lit.tone] : 'text'} weight="bold">
            {b.head}
          </Text>
          {b.ahead > 0 && <Text color="suggestion">{` ↑${b.ahead}`}</Text>}
          {b.behind > 0 && <Text color="suggestion">{` ↓${b.behind}`}</Text>}
        </Box>
        {b.upstream !== '' && (
          <Box flexShrink={1} overflow="hidden">
            <Text color="subtle" wrap="truncate-end">
              {` ${b.upstream}`}
            </Text>
          </Box>
        )}
        <Box flexGrow={1} />
        <Box flexDirection="row" flexShrink={0}>
          {added > 0 && <Text color="success">{` +${added}`}</Text>}
          {removed > 0 && <Text color="error">{` -${removed}`}</Text>}
          {counts.map(c => (
            <Text color={c.color}>{c.text}</Text>
          ))}
          {added === 0 && removed === 0 && counts.length === 0 && <Text color="subtle"> clean</Text>}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text color="suggestion" weight="bold" wrap="truncate-start">
            {rootLabel(paths, t.root)}
          </Text>
        </Box>
        <Box flexDirection="row" flexShrink={0} gap={1}>
          <Button key="up" plain onPress={actions.up}>↑</Button>
          <Button key="cwd" plain {...(t.follow ? {} : { dimColor: true as const })} onPress={actions.cwd}>⌂</Button>
          <Button key="refresh" plain onPress={actions.refresh}>↻</Button>
          <Button key="hidden" plain onPress={actions.hidden}>{t.showHidden ? '◉' : '○'}</Button>
          <Button key="collapse" plain onPress={actions.collapse}>⊟</Button>
          {t.selected !== '' && <Button key="unselect" plain onPress={actions.unselect}>⊘</Button>}
        </Box>
      </Box>
      {layout.extra === 'branch' && branchRow()}
      {layout.extra === 'hint' && (
        <Text color="subtle" wrap="truncate-end">
          {git?.state.available ? '± no git repo · git status starts after git init' : '± git not found · status colors need git on the PATH'}
        </Text>
      )}
      <Box flexDirection="row" gap={2}>
        <Button key="nav-j" plain dimColor hotkey="j" onPress={() => actions.nav('down')}>↓</Button>
        <Button key="nav-k" plain dimColor hotkey="k" onPress={() => actions.nav('up')}>↑</Button>
        <Button key="nav-h" plain dimColor hotkey="h" onPress={() => actions.nav('left')}>←</Button>
        <Button key="nav-l" plain dimColor hotkey="l" onPress={() => actions.nav('right')}>→</Button>
        <Button key="nav-o" plain dimColor hotkey="o" autoFocus onPress={() => actions.nav('return')}>open</Button>
      </Box>
      {terminal ? (
        <Client key="rows" module="./rows.tsx" props={layout.props} height={Math.max(1, layout.props.rows.length)} />
      ) : (
        <Client key="rows" module="./rows.tsx" props={layout.props} />
      )}
      {(t.selected !== '' || chip !== null) && (
        <Box flexDirection="row">
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {t.selected !== '' && (
              <Text color="subtle" wrap="truncate-start">
                selected: {paths.native(paths.relative(t.root, t.selected))}
              </Text>
            )}
          </Box>
          {chip !== null && (
            <Box flexDirection="row" flexShrink={0} marginLeft={2}>
              <Text color={TONE_COLOR[chip.tone]}>{`${chip.icon} ${chip.text}`}</Text>
              {chip.detail !== '' && <Text color="subtle">{` ${chip.detail}`}</Text>}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
