import { expect, it } from 'vitest'
import type { MouseEvent } from 'react'
import { isBackdropClick } from './dialogBackdrop'

it('Only clicks outside the shell count as backdrop clicks; content and blank padding must not close it accidentally', () => {
  const dialog = { getBoundingClientRect: () => ({ left: 100, right: 400, top: 100, bottom: 300 }) }
  const click = (x: number, y: number, target: unknown = dialog) => isBackdropClick({ currentTarget: dialog, target, clientX: x, clientY: y } as MouseEvent<HTMLDialogElement>)
  expect(click(50, 150)).toBe(true)
  expect(click(200, 350)).toBe(true)
  expect(click(120, 120)).toBe(false)
  expect(click(100, 100)).toBe(false)
  expect(click(50, 150, {})).toBe(false)
})
