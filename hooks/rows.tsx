import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { RowsMessage, RowsProps, Seg } from '../types'

// Draws the rows it is handed and posts what the person does. No decisions here:
// the hooks module owns the tree, the layout and what each key or click means.

/** `ref` is mutated in place, so the timer reads what the latest props say without a redraw. */
type Local = { phase: number; ref: { glowing: boolean } }

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
    local = { phase: 0, ref: { glowing: false } }
    surface.setState(local)
    // One timer for the instance's life; it redraws only while a row glows (R5.5).
    surface.every(GLOW_TICK_MS, () => {
      const now = surface.state
      if (now?.ref.glowing) surface.setState({ ...now, phase: now.phase + 1 })
    })
  }
  local.ref.glowing = props.rows.some(r => r.segs.some(s => s.glow))
  const phase = local.phase
  const onBar = (e: ClientPointerEvent) => props.bar !== null && e.x >= surface.columns - 1

  surface.onKey(e => post({ kind: 'key', key: e.key, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}) }))
  surface.onPointer(e => {
    const scrollTo = () => post({ kind: 'scrollTo', fraction: Math.max(0, Math.min(1, e.y / Math.max(1, props.rows.length - 1))) })
    if (e.type === 'move' && e.button === 'left' && onBar(e)) return scrollTo()
    if (e.type !== 'down' || (e.button !== 'left' && e.button !== 'right')) return
    if (e.button === 'left' && onBar(e)) return scrollTo()
    const row = props.rows[e.y]
    if (!row) return
    post({ kind: 'press', id: row.id, button: e.button, ...(e.ctrl ? { ctrl: true } : {}), ...(e.shift ? { shift: true } : {}) })
  })

  if (props.empty !== null) return <Text color="subtle">{props.empty}</Text>

  const plain = (seg: Seg, active: boolean) => (
    <Text
      {...(seg.color ? { color: seg.color } : {})}
      {...(seg.bold ? { weight: 'bold' as const } : {})}
      {...(seg.dim ? { dimColor: true } : {})}
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
        <Box flexDirection="row">
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
