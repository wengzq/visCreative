import { memo, useLayoutEffect, useRef, useState } from 'react'
import type { writingChapters } from '@vis/protocol'

type Chapter = ReturnType<typeof writingChapters>[number]
const rowHeight = 42
const overscan = 8

/** Keep chapter controls bounded too: a manuscript can contain thousands of short headings. */
export const ChapterOutline = memo(function ChapterOutline({ chapters, current, label, empty, render }: {
  chapters: Chapter[]
  current: number | undefined
  label: string
  empty: string
  render(chapter: Chapter): React.ReactNode
}) {
  const nav = useRef<HTMLElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const [viewport, setViewport] = useState({ top: 0, height: 1000 })
  useLayoutEffect(() => {
    const element = nav.current!
    const measure = () => setViewport({ top: element.scrollTop, height: element.clientHeight })
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    measure()
    return () => observer.disconnect()
  }, [])
  useLayoutEffect(() => {
    const element = nav.current!, content = list.current
    const index = chapters.findIndex(chapter => chapter.from === current)
    if (!content || index < 0) return
    const top = content.offsetTop - element.offsetTop + index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) element.scrollTop = top + rowHeight - element.clientHeight
    setViewport({ top: element.scrollTop, height: element.clientHeight })
  }, [current, chapters])
  const first = Math.min(Math.max(0, chapters.length - 1), Math.max(0, Math.floor(viewport.top / rowHeight) - overscan))
  const end = Math.min(chapters.length, first + Math.ceil(viewport.height / rowHeight) + overscan * 2)
  return <nav ref={nav} className="vis-writing-outline" aria-label={label} onScroll={event => setViewport({ top: event.currentTarget.scrollTop, height: event.currentTarget.clientHeight })}>
    <h2>{label}</h2>
    {!chapters.length && <p>{empty}</p>}
    <div ref={list} style={{ paddingTop: first * rowHeight, paddingBottom: Math.max(0, chapters.length - end) * rowHeight }}>
      {chapters.slice(first, end).map(render)}
    </div>
  </nav>
})
