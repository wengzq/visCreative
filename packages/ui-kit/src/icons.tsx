import type { ButtonHTMLAttributes } from 'react'

export function CloseIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" /></svg>
}

export function ChevronDownIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="m4 6 4 4 4-4" /></svg>
}

export function ChevronRightIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="m6 4 4 4-4 4" /></svg>
}

export function PlayIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="m5 3 8 5-8 5Z" /></svg>
}

export function RunningIcon({ active = false }: { active?: boolean }) {
  return <svg className={`vis-running-icon${active ? ' is-active' : ''}`} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true"><path d="M13 8a5 5 0 1 1-5-5" strokeLinecap="round" /></svg>
}

export function IconButton({ label, children, className = '', type = 'button', title, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return <button {...props} type={type} className={`vis-icon-button ${className}`} aria-label={label} title={title ?? label}>{children}</button>
}
