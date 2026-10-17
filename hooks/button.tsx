import type { ClientModule } from 'claude-code'

import type { ButtonProps } from '../types'

// A header button that also tells the hooks module when the pointer is over it, which a Button
// alone does not, so the header can say what the button does (spec-07 R5). No decisions here.

const HeaderButton: ClientModule<ButtonProps, { over: boolean }> = (props, surface) => {
  const { Button } = surface.elements
  surface.onPointer(e => {
    const over = e.type !== 'leave'
    if (over === Boolean(surface.state?.over)) return
    surface.setState({ over })
    surface.post({ over })
  })
  return (
    <Button key={props.id} plain {...(props.dim ? { dimColor: true } : {})} onPress={() => surface.post({ press: true })}>
      {props.label}
    </Button>
  )
}

export default HeaderButton
