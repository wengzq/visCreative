import { expect, it } from 'vitest'
import { IconButton } from './icons'

it('icon buttons use required labels for accessible names and hover descriptions', () => {
  const button = IconButton({ label: 'Close', children: null, disabled: true })
  expect(button.props['aria-label']).toBe('Close')
  expect(button.props.title).toBe('Close')
  expect(button.props.type).toBe('button')
  expect(button.props.disabled).toBe(true)
  expect(button.props.className).toContain('vis-icon-button')
})

it('caller shortcut descriptions remain in hover titles', () => {
  const button = IconButton({ label: 'Close', title: 'Close (Escape)', children: null })
  expect(button.props['aria-label']).toBe('Close')
  expect(button.props.title).toBe('Close (Escape)')
})
