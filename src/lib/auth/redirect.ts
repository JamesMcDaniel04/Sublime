export function safeReturnToPath(value: string | null | undefined, fallback = '/dashboard'): string {
  if (!value || !value.startsWith('/') || value.startsWith('//')) return fallback
  if (value.includes('\\') || /[\u0000-\u001f\u007f\s]/.test(value)) return fallback
  try {
    const parsed = new URL(value, 'https://app.invalid')
    return parsed.origin === 'https://app.invalid' ? `${parsed.pathname}${parsed.search}${parsed.hash}` : fallback
  } catch {
    return fallback
  }
}
