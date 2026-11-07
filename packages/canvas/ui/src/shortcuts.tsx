import { CloseIcon, IconButton, messagesFor, useLocale, useMessages, type Locale } from '@vis/ui-kit'
import { useEffect, useId, useRef } from 'react'
import { controlMessages } from './messages'

type Shortcut = {
  id: string
  group: string
  label: string
  labelEn: string
  keys: string
  keysEn?: string
  common?: boolean
}

function shortcutsFor(locale: Locale): readonly Shortcut[] {
  const m = messagesFor(controlMessages, locale)
  const en = messagesFor(controlMessages, 'en')
  return [
    { id: 'pan-zoom', group: m.shortcutCanvasGroup, label: m.shortcutPanZoomLabel, labelEn: en.shortcutPanZoomLabel, keys: m.shortcutPanZoomKeys, keysEn: en.shortcutPanZoomKeys, common: true },
    { id: 'select', group: m.shortcutCanvasGroup, label: m.shortcutSelectLabel, labelEn: en.shortcutSelectLabel, keys: m.shortcutSelectKeys, keysEn: en.shortcutSelectKeys, common: true },
    { id: 'undo', group: m.shortcutCanvasGroup, label: m.shortcutUndoLabel, labelEn: en.shortcutUndoLabel, keys: m.shortcutUndoKeys, keysEn: en.shortcutUndoKeys, common: true },
    { id: 'clipboard', group: m.shortcutNodeGroup, label: m.shortcutClipboardLabel, labelEn: en.shortcutClipboardLabel, keys: m.shortcutClipboardKeys, keysEn: en.shortcutClipboardKeys, common: true },
    { id: 'delete', group: m.shortcutNodeGroup, label: m.shortcutDeleteLabel, labelEn: en.shortcutDeleteLabel, keys: m.shortcutDeleteKeys, keysEn: en.shortcutDeleteKeys, common: true },
    { id: 'move', group: m.shortcutNodeGroup, label: m.shortcutMoveLabel, labelEn: en.shortcutMoveLabel, keys: m.shortcutMoveKeys, keysEn: en.shortcutMoveKeys },
    { id: 'leave-frame', group: m.shortcutNodeGroup, label: m.shortcutLeaveFrameLabel, labelEn: en.shortcutLeaveFrameLabel, keys: m.shortcutLeaveFrameKeys, keysEn: en.shortcutLeaveFrameKeys },
    { id: 'preview', group: m.shortcutNodeGroup, label: m.shortcutPreviewLabel, labelEn: en.shortcutPreviewLabel, keys: m.shortcutPreviewKeys, keysEn: en.shortcutPreviewKeys, common: true },
    { id: 'versions', group: m.shortcutNodeGroup, label: m.shortcutVersionsLabel, labelEn: en.shortcutVersionsLabel, keys: m.shortcutVersionsKeys, keysEn: en.shortcutVersionsKeys },
    { id: 'save-text', group: m.shortcutNodeGroup, label: m.shortcutSaveTextLabel, labelEn: en.shortcutSaveTextLabel, keys: m.shortcutSaveTextKeys, keysEn: en.shortcutSaveTextKeys },
    { id: 'preview-switch', group: m.shortcutNodeGroup, label: m.shortcutPreviewSwitchLabel, labelEn: en.shortcutPreviewSwitchLabel, keys: m.shortcutPreviewSwitchKeys, keysEn: en.shortcutPreviewSwitchKeys },
    { id: 'preview-zoom', group: m.shortcutNodeGroup, label: m.shortcutPreviewZoomLabel, labelEn: en.shortcutPreviewZoomLabel, keys: m.shortcutPreviewZoomKeys, keysEn: en.shortcutPreviewZoomKeys },
    { id: 'playback', group: m.shortcutNodeGroup, label: m.shortcutPlaybackLabel, labelEn: en.shortcutPlaybackLabel, keys: m.shortcutPlaybackKeys, keysEn: en.shortcutPlaybackKeys },
    { id: 'video-seek', group: m.shortcutNodeGroup, label: m.shortcutVideoSeekLabel, labelEn: en.shortcutVideoSeekLabel, keys: m.shortcutVideoSeekKeys, keysEn: en.shortcutVideoSeekKeys },
    { id: 'video-frame', group: m.shortcutNodeGroup, label: m.shortcutVideoFrameLabel, labelEn: en.shortcutVideoFrameLabel, keys: m.shortcutVideoFrameKeys, keysEn: en.shortcutVideoFrameKeys },
    { id: 'video-mute', group: m.shortcutNodeGroup, label: m.shortcutVideoMuteLabel, labelEn: en.shortcutVideoMuteLabel, keys: m.shortcutVideoMuteKeys, keysEn: en.shortcutVideoMuteKeys },
    { id: 'session-panel', group: m.shortcutSessionGroup, label: m.shortcutSessionPanelLabel, labelEn: en.shortcutSessionPanelLabel, keys: m.shortcutSessionPanelKeys, keysEn: en.shortcutSessionPanelKeys, common: true },
    { id: 'send', group: m.shortcutSessionGroup, label: m.shortcutSendLabel, labelEn: en.shortcutSendLabel, keys: m.shortcutSendKeys, keysEn: en.shortcutSendKeys },
    { id: 'board', group: m.shortcutViewGroup, label: m.shortcutBoardLabel, labelEn: en.shortcutBoardLabel, keys: m.shortcutBoardKeys, keysEn: en.shortcutBoardKeys, common: true },
    { id: 'settings', group: m.shortcutViewGroup, label: m.shortcutSettingsLabel, labelEn: en.shortcutSettingsLabel, keys: m.shortcutSettingsKeys, keysEn: en.shortcutSettingsKeys },
    { id: 'help', group: m.shortcutViewGroup, label: m.shortcutHelpLabel, labelEn: en.shortcutHelpLabel, keys: m.shortcutHelpKeys, keysEn: en.shortcutHelpKeys },
    { id: 'close', group: m.shortcutViewGroup, label: m.shortcutCloseLabel, labelEn: en.shortcutCloseLabel, keys: m.shortcutCloseKeys, keysEn: en.shortcutCloseKeys },
  ]
}

export const SHORTCUTS = shortcutsFor('zh-CN')

export function formatShortcut(keys: string, mac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)) {
  return keys.replaceAll('Mod', mac ? '⌘' : 'Ctrl')
}

function ShortcutList({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  return <dl className="vis-shortcut-list">{shortcuts.map(shortcut => <div key={shortcut.id}><dt>{shortcut.label}</dt><dd><kbd>{formatShortcut(shortcut.keys)}</kbd></dd></div>)}</dl>
}

export function EmptyShortcuts() {
  const m = useMessages(controlMessages)
  const { locale } = useLocale()
  return <section className="vis-empty-shortcuts" aria-label={m.canvasShortcuts} style={{ pointerEvents: 'none' }}>
    <h2>{m.canvasShortcuts}</h2>
    <p>{m.dropMediaHint}</p>
    <ShortcutList shortcuts={shortcutsFor(locale).filter(shortcut => shortcut.common)} />
    <p>{m.allShortcutsHint}</p>
  </section>
}

/** Mount on opening; the canvas restores focus after closing. */
export function ShortcutDialog({ onClose, onRestoreFocus }: { onClose(): void; onRestoreFocus(): void }) {
  const m = useMessages(controlMessages)
  const { locale } = useLocale()
  const shortcuts = shortcutsFor(locale)
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const dialog = ref.current!
    dialog.showModal()
    return () => { dialog.close(); onRestoreFocus() }
  }, [])
  return <dialog ref={ref} className="vis-dialog vis-shortcut-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); event.stopPropagation(); onClose() }} onKeyDown={event => event.stopPropagation()} onClick={event => { if (event.target === event.currentTarget) onClose() }}>
    <header className="vis-dialog-header"><h2 id={titleId}>{m.canvasShortcuts}</h2><IconButton type="button" label={m.closeShortcuts} onClick={onClose}><CloseIcon /></IconButton></header>
    <div className="vis-dialog-body vis-shortcut-groups">{[m.shortcutCanvasGroup, m.shortcutNodeGroup, m.shortcutSessionGroup, m.shortcutViewGroup].map(group => <section key={group}><h3>{group}</h3><ShortcutList shortcuts={shortcuts.filter(shortcut => shortcut.group === group)} /></section>)}</div>
  </dialog>
}
