import { z } from 'zod'

/**
 * Validator for images stored inline as data URLs (workspace logos, profile
 * avatars). Both clients re-encode the chosen file to a small PNG/JPEG/WebP
 * data URL before sending, so no external storage is involved and no external
 * host should ever appear here.
 *
 * The workspace logo was already locked to this shape. The profile avatar was
 * validated as `z.string().url()`, which is a materially weaker check than it
 * looks:
 *
 *   - Zod's `.url()` is a `new URL()` parse, so `javascript:alert(1)` passes —
 *     it is a perfectly valid URL.
 *   - Any external https host passes, which turns an avatar into a tracking
 *     pixel that reports every viewer's IP to whoever set it, and the CSP
 *     cannot help because `img-src` allows https: generally.
 *
 * The client's `accept="image/png,image/jpeg,image/webp"` is a file-picker
 * hint, not a control — a direct PATCH bypasses it entirely. This is the
 * control.
 *
 * Shared so the two call sites cannot drift apart again.
 */
export const INLINE_IMAGE_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/

export function inlineImageDataUrl(maxLength: number) {
  return z
    .string()
    .max(maxLength, 'Image is too large — please use a smaller file.')
    .regex(INLINE_IMAGE_PATTERN, 'Unsupported image format.')
}
