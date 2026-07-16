'use client'

/**
 * Downscale an uploaded image to a small square data URL so it can be stored
 * inline (no object storage) and still render crisply at logo/avatar sizes.
 * Cover-fit: crops the shorter axis so images stay centered and square.
 */
export function resizeImageToDataUrl(
  file: File,
  size = 128,
  options: { mimeType?: 'image/png' | 'image/jpeg' | 'image/webp'; quality?: number } = {},
): Promise<string> {
  const { mimeType = 'image/png', quality } = options
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const image = new Image()
    image.onload = () => {
      URL.revokeObjectURL(url)
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      const context = canvas.getContext('2d')
      if (!context) return reject(new Error('Canvas unavailable'))
      // JPEG has no alpha channel — flatten onto white instead of black.
      if (mimeType === 'image/jpeg') {
        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, size, size)
      }
      // Cover-fit: crop the shorter axis so images stay centered and square.
      const scale = Math.max(size / image.width, size / image.height)
      const width = image.width * scale
      const height = image.height * scale
      context.drawImage(image, (size - width) / 2, (size - height) / 2, width, height)
      resolve(canvas.toDataURL(mimeType, quality))
    }
    image.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not read that image'))
    }
    image.src = url
  })
}
