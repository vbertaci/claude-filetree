import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { RowsMessage, RowsProps, Seg } from '../types'

// Draws the rows it is handed and posts what the person does. No decisions here:
// the hooks module owns the tree, the layout and what each key or click means.

/**
 * `ref` is mutated in place, so the timer reads what the latest props say without a redraw.
 * `hover` is the row under a resting pointer, -1 for none; it never leaves the Client (spec-07 R6.4).
 */
type Local = { phase: number; hover: number; ref: { glowing: boolean } }

const GLOW_TICK_MS = 90

/** Splits a lit name around the band that runs along it (R5.4). */
function band(text: string, phase: number): [string, string, string] {
  const chars = [...text]
  const center = ((phase * 1.6) % (chars.length + 8)) - 4
  const inBand = chars.map((_, i) => Math.abs(i - center) < 1.8)
  const first = inBand.indexOf(true)
  if (first < 0) return [text, '', '']
  const end = inBand.lastIndexOf(true) + 1
  return [chars.slice(0, first).join(''), chars.slice(first, end).join(''), chars.slice(end).join('')]
}

const Rows: ClientModule<RowsProps, Local> = (props, surface) => {
  const { Box, Text } = surface.elements
  const post = (message: RowsMessage) => surface.post(message)

  let local = surface.state
  if (local === undefined) {
    local = { phase: 0, hover: -1, ref: { glowing: false } }
    surface.setState(local)
    // One timer for the instance's life; it redraws only while a row glows (R5.5).
    surface.every(GLOW_TICK_MS, () => {
      const now = surface.state
      if (now?.ref.glowing) surface.setState({ ...now, phase: now.phase + 1 })
    })
  }
  local.ref.glowing = props.rows.some(r => r.segs.some(s => s.glow))
  const phase = local.phase
  const hover = local.hover
  const onBar = (e: ClientPointerEvent) => props.bar !== null && e.x >= surface.columns - 1
  const preview = props.preview

  surface.onKey(e => post({ kind: 'key', key: e.key, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}) }))
  const hoverAt = (y: number) => {
    const now = surface.state
    if (now && now.hover !== y) surface.setState({ ...now, hover: y })
  }
  surface.onPointer(e => {
    // The preview has no rows to press; its keys still post (spec-08 R6.1).
    if (preview) return
    const scrollTo = () => {
      hoverAt(-1)
      post({ kind: 'scrollTo', fraction: Math.max(0, Math.min(1, e.y / Math.max(1, props.rows.length - 1))) })
    }
    if (e.type === 'leave') return hoverAt(-1)
    if (e.type === 'move' && e.button === undefined) return hoverAt(e.y >= 0 && e.y < props.rows.length ? e.y : -1)
    if (e.type === 'move' && e.button === 'left' && onBar(e)) return scrollTo()
    if (e.type !== 'down' || (e.button !== 'left' && e.button !== 'right')) return
    if (e.button === 'left' && onBar(e)) return scrollTo()
    const row = props.rows[e.y]
    if (!row) return
    post({ kind: 'press', id: row.id, button: e.button, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}) })
  })

  // The preview draws in this same element, so the keys and the focus stay where they were (spec-08 R5.2).
  if (preview) {
    const { Markdown, Code } = surface.elements
    if (preview.text === '') return <Text> </Text>
    return preview.markdown ? (
      <Markdown text={preview.text} />
    ) : (
      <Code source={preview.text} path={preview.path} startLine={preview.startLine} wrap="truncate-end" />
    )
  }

  if (props.empty !== null) return <Text color="subtle">{props.empty}</Text>

  const plain = (seg: Seg, active: boolean) => (
    <Text
      {...(seg.color ? { color: seg.color } : {})}
      {...(seg.bold ? { weight: 'bold' as const } : {})}
      {...(seg.dim ? { dimColor: true } : {})}
      {...(seg.strike ? { strikethrough: true } : {})}
      {...(active ? { inverse: true } : {})}
    >
      {seg.text}
    </Text>
  )
  // Bright: the band bold, the rest dim. Faint: the band plain, the rest dim.
  const glowing = (seg: Seg, active: boolean) =>
    band(seg.text, phase)
      .map((text, part) => ({ text, color: seg.color, ...(part === 1 ? (seg.glow === 'bright' ? { bold: true as const } : {}) : { dim: true as const }) }))
      .filter(part => part.text !== '')
      .map(part => plain(part, active))

  const bar = props.bar
  return (
    <Box flexDirection="column">
      {props.rows.map((row, y) => (
        <Box flexDirection="row" {...(y === hover && !row.active ? { backgroundColor: 'subtle' as const } : {})}>
          {row.segs.flatMap(seg => (seg.glow ? glowing(seg, row.active) : [plain(seg, row.active)]))}
          {bar !== null &&
            (y >= bar.thumbFrom && y < bar.thumbFrom + bar.thumbSize ? (
              <Text color="suggestion">┃</Text>
            ) : (
              <Text color="subtle">│</Text>
            ))}
        </Box>
      ))}
      {props.more > 0 && <Text color="subtle">… {props.more} more rows, collapse folders</Text>}
    </Box>
  )
}

export default Rows
