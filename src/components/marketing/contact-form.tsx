'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ArrowRight } from 'lucide-react'

const REASONS = [
  { value: 'enterprise', label: 'Sales & enterprise' },
  { value: 'support', label: 'Support' },
  { value: 'billing', label: 'Billing' },
  { value: 'privacy', label: 'Privacy & security' },
  { value: 'feedback', label: 'Feedback' },
  { value: 'other', label: 'Other' },
]

const FIELD_CLASSES =
  'w-full border border-input bg-background px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring transition-colors'

/**
 * Contact form in the landing visual language. Submissions go to
 * hello@trysublime.io via /api/contact; ?reason=<key> preselects the topic
 * (e.g. the in-app "Enterprise — contact sales" button links ?reason=enterprise).
 */
export function ContactForm() {
  const searchParams = useSearchParams()
  const initialReason = REASONS.some((r) => r.value === searchParams.get('reason'))
    ? (searchParams.get('reason') as string)
    : 'support'

  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [company, setCompany] = useState('')
  const [reason, setReason] = useState(initialReason)
  const [message, setMessage] = useState('')
  const [website, setWebsite] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent'>('idle')
  const [error, setError] = useState('')

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    setStatus('sending')
    setError('')
    try {
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, company, reason, message, website }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.ok && data.success) {
        setStatus('sent')
      } else {
        setStatus('idle')
        setError(data.error || 'We could not send your message. Please email us at hello@trysublime.io.')
      }
    } catch {
      setStatus('idle')
      setError('We could not send your message. Please email us at hello@trysublime.io.')
    }
  }

  if (status === 'sent') {
    return (
      <div className="border border-border bg-card p-8">
        <p className="text-[12px] uppercase tracking-[0.15em] text-muted-foreground">Message sent</p>
        <h2 className="mt-3 text-[20px] font-[500] tracking-[-0.02em] text-foreground">
          Thanks, we&apos;ll be in touch.
        </h2>
        <p className="mt-3 text-[14px] leading-[1.7] text-muted-foreground">
          Your message is on its way to the team. We usually reply within one business day.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="border border-border bg-card p-8">
      {error && (
        <div className="mb-5 border border-destructive/40 bg-destructive/10 p-3 text-[13px] text-destructive">
          {error}
        </div>
      )}
      <div className="grid gap-5 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className="mb-1.5 block text-[12px] uppercase tracking-[0.12em] text-foreground/80">
            Name
          </label>
          <input id="contact-name" required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={FIELD_CLASSES} placeholder="Your name" />
        </div>
        <div>
          <label htmlFor="contact-email" className="mb-1.5 block text-[12px] uppercase tracking-[0.12em] text-foreground/80">
            Email
          </label>
          <input id="contact-email" type="email" required maxLength={320} value={email} onChange={(e) => setEmail(e.target.value)} className={FIELD_CLASSES} placeholder="you@company.com" />
        </div>
        <div>
          <label htmlFor="contact-company" className="mb-1.5 block text-[12px] uppercase tracking-[0.12em] text-foreground/80">
            Company <span className="normal-case tracking-normal text-muted-foreground">(optional)</span>
          </label>
          <input id="contact-company" maxLength={200} value={company} onChange={(e) => setCompany(e.target.value)} className={FIELD_CLASSES} placeholder="Company name" />
        </div>
        <div>
          <label htmlFor="contact-reason" className="mb-1.5 block text-[12px] uppercase tracking-[0.12em] text-foreground/80">
            Reason
          </label>
          <select id="contact-reason" value={reason} onChange={(e) => setReason(e.target.value)} className={FIELD_CLASSES}>
            {REASONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </div>
      </div>
      <div className="mt-5">
        <label htmlFor="contact-message" className="mb-1.5 block text-[12px] uppercase tracking-[0.12em] text-foreground/80">
          Message
        </label>
        <textarea
          id="contact-message"
          required
          maxLength={5000}
          rows={5}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          className={FIELD_CLASSES}
          placeholder="What can we help with?"
        />
      </div>
      {/* Honeypot — hidden from people, tempting to bots. */}
      <input
        type="text"
        name="website"
        value={website}
        onChange={(e) => setWebsite(e.target.value)}
        className="hidden"
        tabIndex={-1}
        autoComplete="off"
        aria-hidden="true"
      />
      <button
        type="submit"
        disabled={status === 'sending'}
        className="group mt-6 inline-flex items-center gap-2 bg-foreground px-6 py-3 text-[14px] font-medium text-background transition-colors hover:bg-foreground/90 disabled:opacity-60"
      >
        {status === 'sending' ? 'Sending…' : 'Send message'}
        <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
      </button>
    </form>
  )
}
