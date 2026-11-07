import type { KeyboardEvent } from 'react'

export function containDialogFocus(event: KeyboardEvent<HTMLElement>) {
  if (event.key !== 'Tab') return
  const elements = [...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not([hidden]), [contenteditable="true"], [tabindex="0"]')].filter(element => element.getClientRects().length)
  const first = elements[0]
  const last = elements.at(-1)
  if (!first || !last) return
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
