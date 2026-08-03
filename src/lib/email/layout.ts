/** Shared product-email shell. Body HTML is caller-owned; all shell values are escaped. */
export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

export function wrapEmailHtml(input: {
  heading: string
  bodyHtml: string
  cta?: { label: string; url: string }
  unsubscribeUrl?: string | null
}): string {
  const cta = input.cta
    ? `<p style="margin:24px 0"><a href="${escapeHtml(input.cta.url)}" style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">${escapeHtml(input.cta.label)}</a></p>`
    : ''
  const unsubscribe = input.unsubscribeUrl
    ? `<p style="margin-top:32px;font-size:12px;color:#888"><a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#888">Unsubscribe</a> from emails like this.</p>`
    : ''
  return `<div style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#222"><h1 style="font-size:20px">${escapeHtml(input.heading)}</h1>${input.bodyHtml}${cta}${unsubscribe}<p style="margin-top:32px;font-size:12px;color:#888">— The Sublime team</p></div>`
}
