import { z } from 'zod'

// All object IDs are ULIDs with type prefixes (see RFC 0002 "Conventions"); the protocol validates only shape, without parsing prefixes.
export const Id = z.string().min(1).max(64)
export const RequestId = z.string().min(1).max(128)
export const Revision = z.int().nonnegative()

// 0023: script nodes hold a storyboard document; 0024: timeline nodes hold an edit document
export const NodeKind = z.enum(['image', 'video', 'audio', 'text', 'script', 'timeline', 'previz', 'scene'])
export type NodeKind = z.infer<typeof NodeKind>

// Canvas frames (0009): have no slots and only define work item write boundaries.
export const CanvasNodeKind = z.enum(['image', 'video', 'audio', 'text', 'script', 'timeline', 'previz', 'scene', 'frame'])
export type CanvasNodeKind = z.infer<typeof CanvasNodeKind>

export const MediaKind = z.enum(['image', 'video', 'audio'])
export type MediaKind = z.infer<typeof MediaKind>
// 0024d: font assets are referenced by timeline text and never placed on the canvas
export const AssetKind = z.enum([...MediaKind.options, 'font', 'model'])
export type AssetKind = z.infer<typeof AssetKind>
export function isMediaKind(kind: AssetKind): kind is MediaKind {
  return kind === 'image' || kind === 'video' || kind === 'audio'
}
