export type CropBox = { x: number; y: number; w: number; h: number }
export type ImageSize = { w: number; h: number }

export function fitCrop(size: ImageSize, ratio?: number): CropBox {
  const w = ratio ? Math.max(1, Math.min(size.w, Math.floor(size.h * ratio))) : size.w
  const h = ratio ? Math.max(1, Math.min(size.h, Math.floor(w / ratio))) : size.h
  return { x: Math.floor((size.w - w) / 2), y: Math.floor((size.h - h) / 2), w, h }
}

export function clampCrop(box: CropBox, size: ImageSize): CropBox {
  const w = Math.max(1, Math.min(size.w, Math.round(box.w)))
  const h = Math.max(1, Math.min(size.h, Math.round(box.h)))
  return { x: Math.max(0, Math.min(size.w - w, Math.round(box.x))), y: Math.max(0, Math.min(size.h - h, Math.round(box.y))), w, h }
}

export function resizeCrop(box: CropBox, dx: number, dy: number, size: ImageSize, ratio?: number): CropBox {
  let w = Math.max(1, Math.min(size.w - box.x, box.w + dx))
  let h = Math.max(1, Math.min(size.h - box.y, box.h + dy))
  if (ratio) {
    w = Math.max(1, Math.min(w, (size.h - box.y) * ratio))
    h = w / ratio
  }
  return clampCrop({ ...box, w, h }, size)
}
