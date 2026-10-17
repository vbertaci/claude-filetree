import type { EngineInterface, RenderElement, RenderInput } from 'claude-code'

import type { RowSpec, RowsProps, Seg, TreeState } from '../types'
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

export type Layout = {
  rows: Row[]
  from: number
  max: number
  room: number
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

export function rootLabel(paths: Paths, root: string): string {
  return paths.parent(root) === null ? paths.native(root) : paths.base(root)
}

function fixedWidth(row: Row, bar: number): number {
  const suffix = row.node.error ? ' (unreadable)' : ''
  return row.depth * 2 + 2 + 2 + bar + suffix.length
}

function rowSpec(row: Row, t: TreeState, width: number, bar: number, showDate: boolean): RowSpec {
  const { node } = row
  const fixed = fixedWidth(row, bar)
  const dated = showDate && node.kind === 'file'
  const budget = Math.max(1, dated ? width - fixed - (DATE_WIDTH + 1) : width - fixed)
  const name = node.name.length > budget ? `${node.name.slice(0, budget - 1)}…` : node.name
  const isSelected = node.id === t.selected

  const used = fixed - bar + name.length
  const date = dated ? formatDate(node.mtimeMs) : ''
  const pad = ' '.repeat(Math.max(dated ? 1 : 0, width - bar - used - date.length))
  const indent = '  '.repeat(row.depth)
  const caret = node.kind === 'dir' ? (row.isOpen ? '▾ ' : '▸ ') : '  '
  const glyph = `${GLYPH[node.kind]} `

  // Spaces take the style of the segment they join, so a row is as few segments as its colors.
  const segs: Seg[] =
    node.kind === 'dir'
      ? [{ text: indent + caret, color: 'subtle' }, { text: glyph, color: 'suggestion' }]
      : [{ text: indent + caret + glyph, color: 'subtle' }]
  const nameStyle = { color: node.hidden ? ('subtle' as const) : ('text' as const), ...(isSelected ? { bold: true as const } : {}) }
  if (node.error) segs.push({ text: name, ...nameStyle }, { text: ` (unreadable)${pad}`, color: 'error' })
  else segs.push({ text: name + pad, ...nameStyle })
  if (dated) segs.push({ text: date, color: 'subtle' })
  return { id: node.id, segs, active: node.id === t.cursor }
}

/** Which rows the Client gets, and the window they come from (R4, R5). */
export function layoutPane(
  t: TreeState,
  view: { surface: string; bodyColumns: number; bodyRows: number },
): Layout {
  const rows = visibleRows(t)
  const width = Math.max(1, view.bodyColumns)
  if (view.surface !== 'terminal') {
    const candidates = rows.slice(0, DESKTOP_ROW_CAP)
    const showDate = Math.min(...candidates.filter(r => r.node.kind === 'file').map(r => width - fixedWidth(r, 0) - DATE_WIDTH - 1)) >= MIN_NAME
    // Whichever comes first: the row cap or the character budget of the Client's props.
    const specs: RowSpec[] = []
    let chars = 0
    for (const r of candidates) {
      const spec = rowSpec(r, t, width, 0, showDate)
      chars += JSON.stringify(spec).length + 1
      if (chars > DESKTOP_CHAR_BUDGET) break
      specs.push(spec)
    }
    return {
      rows,
      from: 0,
      max: 0,
      room: rows.length,
      props: {
        rows: specs,
        bar: null,
        empty: rows.length === 0 ? 'empty' : null,
        more: rows.length - specs.length,
      },
    }
  }

  const fixedRows = 2 + (t.selected !== '' ? 1 : 0)
  const room = Math.max(5, view.bodyRows - fixedRows)
  const cursorIndex = rows.findIndex(r => r.id === t.cursor)
  const { from, max } = windowOf(rows.length, cursorIndex, room, t.scroll)
  const shown = rows.slice(from, from + room)
  const bar = rows.length > room ? 1 : 0
  const showDate = Math.min(...shown.filter(r => r.node.kind === 'file').map(r => width - fixedWidth(r, bar) - DATE_WIDTH - 1)) >= MIN_NAME
  const thumbSize = Math.max(1, Math.round((room * room) / Math.max(1, rows.length)))
  return {
    rows,
    from,
    max,
    room,
    props: {
      rows: shown.map(r => rowSpec(r, t, width, bar, showDate)),
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
  actions: PaneActions,
): RenderElement {
  const { Box, Text, Button, Client } = $.ui.resolve(e)
  const terminal = e.surface === 'terminal'

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
      {t.selected !== '' && (
        <Text color="subtle" wrap="truncate-start">
          selected: {paths.native(paths.relative(t.root, t.selected))}
        </Text>
      )}
    </Box>
  )
}
