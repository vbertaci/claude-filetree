import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { ButtonProps, GitChip, GitLetter, GitState, Glow, RowSpec, RowsProps, Seg, ThemeKeyName, Tone, TreeState } from '../types'
import { type ColumnMode, cellText, widthOf } from './columns'
import { isMarkdown, windowLines } from './open'
import { BRANCH_ID, type NodeGit, gitOf } from './git'
import { type GlyphSet, LABELS, caret, chipIcon, cols, nodeGlyph, take } from './icons'
import type { Paths } from './os'
import { termOf } from './search'
import { type Row, visibleRows, windowOf } from './tree'

export const DESKTOP_ROW_CAP = 1500
/**
 * Serialized RowSpec characters the desktop sends. Both the Client's props and the tree it draws
 * must stay under 100,000 characters, and the drawn tree runs about 1.5 times the props.
 */
export const DESKTOP_CHAR_BUDGET = 45_000
const MIN_NAME = 12
/** The narrowest title a hint leaves (spec-07 R5.4). */
const MIN_TITLE = 8

/** The header buttons, each a Client of its own, in the order they show (spec-07 R5.1). */
export const HEADER_IDS = ['up', 'cwd', 'refresh', 'hidden', 'size', 'collapse', 'unselect'] as const
export type HeaderId = (typeof HEADER_IDS)[number]

/** What glows while a glow is live; `focus` is null when follow is off. */
export type GlowView = { lit: Record<string, Glow>; focus: string | null } | null

/** What the render knows of git; null before the first read of the current root (spec-03 R7.3). */
export type GitView = { state: GitState; hints: boolean } | null

/** The row under the header: the branch inside a repository, the hint outside one. */
export type Extra = 'branch' | 'hint' | null

/** How the rows look: the column's mode, the folder sizes of this root by Paths.key, the glyph set, the time (spec-07). */
export type Look = { mode: ColumnMode; bytes: Record<string, number>; glyphs: GlyphSet; now: number }

export type Layout = {
  rows: Row[]
  from: number
  max: number
  room: number
  extra: Extra
  props: RowsProps
  /** In the size mode, the folders the Client gets that have no size yet (spec-07 R3.1). */
  sizeWanted: string[]
}

/** What the header draws besides the tree: the glyphs, the column, the button under the pointer, the footer's @ (spec-09 R2.2). */
export type HeaderLook = { glyphs: GlyphSet; mode: ColumnMode; timeMode: 'date' | 'age'; hovered: string; mention: boolean }

/** Each returns the work it started, so a press settles once that work has. The header buttons post instead. */
export type PaneActions = {
  nav: (key: 'down' | 'up' | 'left' | 'right' | 'return') => Promise<unknown>
  search: (value: string) => Promise<unknown>
  jump: (value: string) => Promise<unknown>
  clear: () => Promise<unknown>
  focusSearch: () => Promise<unknown>
  mention: () => Promise<unknown>
}

/** The preview's file, window and text; `lines` is null while the text is being read (spec-08 R4.6). */
export type PreviewView = { id: string; name: string; top: number; rows: number; lines: string[] | null; note: string }

/** What the preview's header draws besides the file: the glyphs, the button under the pointer, the edit button. */
export type PreviewLook = { glyphs: GlyphSet; hovered: string; edit: boolean }

export type PreviewActions = {
  back: () => Promise<unknown>
  scroll: (key: 'down' | 'up' | 'pagedown' | 'pageup') => Promise<unknown>
  edit: () => Promise<unknown>
}

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

const width = (segs: readonly Seg[]): number => segs.reduce((n, s) => n + cols(s.text), 0)

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

/** What a row's column and glyph read: the look, and the lookups that need the paths. */
type RowLook = Look & { bytesOf: (id: string) => number | undefined; isRepo: (id: string) => boolean }

/** The `+a -d` a row draws: none in the size mode, where the size takes the column (spec-07 R2.4). */
const locOf = (cells: Cells, mode: ColumnMode): Seg[] => (mode === 'size' ? [] : cells.loc)

/** The narrowest name the column leaves, among the rows it shows on (spec-01 R4.4, spec-07 R2.5). */
function showsColumn(rows: readonly Row[], cellsOf: (r: Row) => Cells, bar: number, total: number, mode: ColumnMode): boolean {
  const counted = rows.filter(r =>
    mode === 'size' ? r.node.kind === 'file' || r.node.kind === 'dir' : r.node.kind === 'file' && cellsOf(r).loc.length === 0,
  )
  return Math.min(...counted.map(r => total - fixedWidth(r, bar, cellsOf(r)) - widthOf(mode) - 1)) >= MIN_NAME
}

function rowSpec(row: Row, t: TreeState, total: number, bar: number, showColumn: boolean, glow: GlowView, cells: Cells, look: RowLook): RowSpec {
  const { node } = row
  const fixed = fixedWidth(row, bar, cells)
  const locSegs = locOf(cells, look.mode)
  const loc = width(locSegs)
  const text = showColumn && loc === 0 ? cellText(look.mode, node, look.bytesOf(node.id), look.now) : ''
  const column = text === '' ? '' : text.padStart(widthOf(look.mode))
  const budget = Math.max(1, total - fixed - (loc > 0 ? loc : column !== '' ? cols(column) + 1 : 0))
  const name = cols(node.name) > budget ? `${take(node.name, budget - 1)}…` : node.name
  const isSelected = node.id === t.selected

  const used = fixed - bar + cols(name)
  const pad = ' '.repeat(Math.max(column !== '' ? 1 : 0, total - bar - used - cols(column) - loc))
  const indent = '  '.repeat(row.depth)
  const turn = node.kind === 'dir' ? caret(look.glyphs, row.isOpen) : '  '
  const glyph = `${nodeGlyph(look.glyphs, node, row.isOpen, look.isRepo(node.id))} `

  // Spaces take the style of the segment they join, so a row is as few segments as its colors.
  const segs: Seg[] =
    node.kind === 'dir'
      ? [{ text: indent + turn, color: 'subtle' }, { text: glyph, color: 'suggestion' }]
      : [{ text: indent + turn + glyph, color: 'subtle' }]
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
  if (column !== '') segs.push({ text: column, color: 'subtle' })
  segs.push(...locSegs, ...cells.cell)
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
  keep: ReadonlySet<string> | null,
  look: Look,
): Layout {
  const rows = visibleRows(t, keep)
  const total = Math.max(1, view.bodyColumns)
  const extra = extraOf(git)
  const repo = git !== null && git.state.top !== '' ? git.state : null
  const rowLook: RowLook = {
    ...look,
    bytesOf: id => look.bytes[paths.key(id)],
    isRepo: id => repo !== null && paths.same(id, repo.top),
  }
  // The folders drawn without a size, for the render to queue (spec-07 R3.1, R3.6).
  const wanted = (drawn: readonly Row[]): string[] =>
    look.mode === 'size' ? drawn.filter(r => r.node.kind === 'dir' && rowLook.bytesOf(r.id) === undefined).map(r => r.id) : []
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
    const showColumn = showsColumn(candidates, cellsOf, 0, total, look.mode)
    // Whichever comes first: the row cap or the character budget of the Client's props.
    const specs: RowSpec[] = []
    let chars = 0
    for (const r of candidates) {
      const spec = rowSpec(r, t, total, 0, showColumn, glow, cellsOf(r), rowLook)
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
      sizeWanted: wanted(candidates.slice(0, specs.length)),
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
  const showColumn = showsColumn(shown, cellsOf, bar, total, look.mode)
  const thumbSize = Math.max(1, Math.round((room * room) / Math.max(1, rows.length)))
  return {
    rows,
    from,
    max,
    room,
    extra,
    props: {
      rows: shown.map(r => rowSpec(r, t, total, bar, showColumn, glow, cellsOf(r), rowLook)),
      bar: bar ? { thumbFrom: max === 0 ? 0 : Math.round((from / max) * (room - thumbSize)), thumbSize } : null,
      empty: rows.length === 0 ? 'empty' : null,
      more: 0,
    },
    sizeWanted: wanted(shown),
  }
}

type HeaderButton = ButtonProps & { id: HeaderId; hint: string }

/** The header buttons with their labels and what each does, as the hint says it (spec-07 R1.2, R5, Dicas). */
function headerButtons(t: TreeState, look: HeaderLook): HeaderButton[] {
  const L = LABELS[look.glyphs]
  const sizeOn = look.mode === 'size'
  return [
    { id: 'up', label: L.up, dim: false, hint: 'parent folder' },
    { id: 'cwd', label: L.cwd, dim: !t.follow, hint: 'follow the cwd' },
    { id: 'refresh', label: L.refresh, dim: false, hint: 'reload tree and git' },
    {
      id: 'hidden',
      label: t.showHidden ? L['hidden-on'] : L['hidden-off'],
      dim: false,
      hint: t.showHidden ? 'hide hidden files' : 'show hidden files',
    },
    { id: 'size', label: L.size, dim: !sizeOn, hint: !sizeOn ? 'show sizes' : look.timeMode === 'age' ? 'show ages' : 'show dates' },
    { id: 'collapse', label: L.collapse, dim: false, hint: 'collapse all' },
    ...(t.selected !== '' ? [{ id: 'unselect' as const, label: L.unselect, dim: false, hint: 'clear selection' }] : []),
  ]
}

/** The hovered button's hint, or '' when it would squeeze the title under MIN_TITLE columns (spec-07 R5.4). */
function hintOf(buttons: readonly { id: string; label: string; hint: string }[], hovered: string, bodyColumns: number): string {
  const text = buttons.find(b => b.id === hovered)?.hint
  const buttonsWidth = buttons.reduce((n, b) => n + cols(b.label), 0) + Math.max(0, buttons.length - 1)
  const room = bodyColumns - buttonsWidth - MIN_TITLE
  return text !== undefined && cols(text) + 1 <= room ? text : ''
}

/** The preview's window: the body less its two fixed rows and the note on the terminal, the whole text on the desktop (spec-08 R5.3). */
export function previewRowsOf(surface: string, bodyRows: number, note: string, total: number): number {
  return surface === 'terminal' ? Math.max(4, bodyRows - 2 - (note !== '' ? 1 : 0)) : Math.max(1, total)
}

/** The preview in place of the tree: its header, its scroll buttons, the note and the window (spec-08 R5). */
export function renderPreview(
  $: EngineInterface,
  e: RenderInput<'Pane', 'terminal' | 'desktop'>,
  view: PreviewView,
  look: PreviewLook,
  actions: PreviewActions,
): RenderElement {
  const { Box, Text, Button, Client } = $.ui.resolve(e)
  const L = LABELS[look.glyphs]
  const external = { id: 'external', label: L.external, hint: 'open in default app' }
  // The back button takes its columns from the title's room, as a header button does.
  const hint = hintOf([external], look.hovered, e.props.bodyColumns - cols(L.back) - 1)
  const markdown = isMarkdown(view.id)
  const win = view.lines === null ? null : windowLines(view.lines, view.top, view.rows, markdown)
  const line = (win?.top ?? 0) + 1
  const props: RowsProps | null =
    win === null ? null : { rows: [], bar: null, empty: null, more: 0, preview: { text: win.text, path: view.id, startLine: win.top + 1, markdown } }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Button key="back" plain hotkey="h" onPress={actions.back}>{L.back}</Button>
        <Text> </Text>
        <Box flexGrow={1} flexShrink={1} overflow="hidden">
          <Text weight="bold" wrap="truncate-start">
            {view.name}
          </Text>
        </Box>
        {hint !== '' && <Text color="subtle">{`${hint} `}</Text>}
        <Client key="button-external" module="./button.tsx" props={{ id: 'external', label: L.external, dim: true } satisfies ButtonProps} />
      </Box>
      <Box flexDirection="row" gap={2}>
        <Button key="pv-j" plain dimColor hotkey="j" onPress={() => actions.scroll('down')}>{L['pv-j']}</Button>
        <Button key="pv-k" plain dimColor hotkey="k" onPress={() => actions.scroll('up')}>{L['pv-k']}</Button>
        <Button key="pv-f" plain dimColor hotkey="f" onPress={() => actions.scroll('pagedown')}>{L['pv-f']}</Button>
        <Button key="pv-b" plain dimColor hotkey="b" onPress={() => actions.scroll('pageup')}>{L['pv-b']}</Button>
        {look.edit && <Button key="edit" plain dimColor hotkey="e" onPress={actions.edit}>{`${L.edit} :${line}`}</Button>}
      </Box>
      {view.note !== '' && (
        <Text color="subtle" wrap="truncate-end">
          {view.note}
        </Text>
      )}
      {props === null ? (
        <Text color="subtle">loading…</Text>
      ) : e.surface === 'terminal' ? (
        <Client key="rows" module="./rows.tsx" props={props} height={Math.max(1, view.rows)} />
      ) : (
        <Client key="rows" module="./rows.tsx" props={props} />
      )}
    </Box>
  )
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
  query: string,
  look: HeaderLook,
  actions: PaneActions,
): RenderElement {
  const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
  const terminal = e.surface === 'terminal'
  const L = LABELS[look.glyphs]
  const buttons = headerButtons(t, look)
  const hint = hintOf(buttons, look.hovered, e.props.bodyColumns)

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
            {`${L.branch} `}
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
        {hint !== '' && <Text color="subtle">{`${hint} `}</Text>}
        {/* Each button is a Client only so it can say when the pointer is over it; a press posts back (spec-07 R5). */}
        <Box flexDirection="row" flexShrink={0} gap={1}>
          {buttons.map(b => (
            <Client key={`button-${b.id}`} module="./button.tsx" props={{ id: b.id, label: b.label, dim: b.dim } satisfies ButtonProps} />
          ))}
        </Box>
      </Box>
      {layout.extra === 'branch' && branchRow()}
      {layout.extra === 'hint' && (
        <Text color="subtle" wrap="truncate-end">
          {git?.state.available ? '± no git repo · git status starts after git init' : '± git not found · status colors need git on the PATH'}
        </Text>
      )}
      <Box flexDirection="row" gap={2}>
        <Button key="nav-j" plain dimColor hotkey="j" onPress={() => actions.nav('down')}>{L['nav-j']}</Button>
        <Button key="nav-k" plain dimColor hotkey="k" onPress={() => actions.nav('up')}>{L['nav-k']}</Button>
        <Button key="nav-h" plain dimColor hotkey="h" onPress={() => actions.nav('left')}>{L['nav-h']}</Button>
        <Button key="nav-l" plain dimColor hotkey="l" onPress={() => actions.nav('right')}>{L['nav-l']}</Button>
        <Button key="nav-o" plain dimColor hotkey="o" autoFocus onPress={() => actions.nav('return')}>{L['nav-o']}</Button>
        {/* The search shares the row and gives way first, so the tree keeps its rows (spec-06 R1.1, R1.4). */}
        <Box flexDirection="row" flexGrow={1} flexShrink={1} overflow="hidden">
          <Button key="nav-s" plain dimColor hotkey="s" onPress={actions.focusSearch}>{L['nav-s']}</Button>
          <Box flexGrow={1} flexShrink={1}>
            <Input key="q" placeholder="search" submitLabel="jump" value={query} onInput={actions.search} onSubmit={actions.jump} />
          </Box>
          {termOf(query) !== '' && <Button key="clear" plain dimColor onPress={actions.clear}>×</Button>}
        </Box>
      </Box>
      {terminal ? (
        <Client key="rows" module="./rows.tsx" props={layout.props} height={Math.max(1, layout.props.rows.length)} />
      ) : (
        <Client key="rows" module="./rows.tsx" props={layout.props} />
      )}
      {(t.selected !== '' || chip !== null) && (
        <Box flexDirection="row">
          {/* The selection reaches the prompt box only when the person asks, in plain sight (spec-09 R2.2). */}
          {t.selected !== '' && look.mention && (
            <Box flexShrink={0} marginRight={1}>
              <Button key="mention" plain dimColor onPress={actions.mention}>{L.mention}</Button>
            </Box>
          )}
          <Box flexGrow={1} flexShrink={1} overflow="hidden">
            {t.selected !== '' && (
              <Text color="subtle" wrap="truncate-start">
                selected: {paths.native(paths.relative(t.root, t.selected))}
              </Text>
            )}
          </Box>
          {chip !== null && (
            <Box flexDirection="row" flexShrink={0} marginLeft={2}>
              <Text color={TONE_COLOR[chip.tone]}>{`${chipIcon(look.glyphs, chip.icon)} ${chip.text}`}</Text>
              {chip.detail !== '' && <Text color="subtle">{` ${chip.detail}`}</Text>}
            </Box>
          )}
        </Box>
      )}
    </Box>
  )
}
