import type { ClientModule, ClientPointerEvent } from 'claude-code'

import type { RowsMessage, RowsProps } from '../types'

// Draws the rows it is handed and posts what the person does. No decisions here:
// the hooks module owns the tree, the layout and what each key or click means.

const Rows: ClientModule<RowsProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  const post = (message: RowsMessage) => surface.post(message)
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

  const bar = props.bar
  return (
    <Box flexDirection="column">
      {props.rows.map((row, y) => (
        <Box flexDirection="row">
          {row.segs.map(seg => (
            <Text
              {...(seg.color ? { color: seg.color } : {})}
              {...(seg.bold ? { weight: 'bold' as const } : {})}
              {...(seg.dim ? { dimColor: true } : {})}
              {...(row.active ? { inverse: true } : {})}
            >
              {seg.text}
            </Text>
          ))}
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
