'use client'

import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { AuthShell } from '@/components/auth/auth-shell'

export default function AuthCodeErrorPage() {
  return (
    <AuthShell
      eyebrow="Sign-in problem"
      title="We couldn't sign you in"
      subtitle="That sign-in didn't complete. It usually takes one more click to fix."
    >
      <div className="space-y-4">
        <ul className="space-y-2.5 text-[13px] leading-[1.6] text-muted-foreground">
          <li className="flex items-start gap-2.5">
            <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-primary" />
            <span>
              <strong className="font-medium text-foreground">Signed in with Google?</strong> Just
              try again — it works right away. This can happen when the round-trip started on a
              different address of the site.
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <span className="mt-[8px] h-1 w-1 shrink-0 rounded-full bg-primary" />
            <span>
              <strong className="font-medium text-foreground">Clicked an email link?</strong> Those
              work once and expire after a short while — head back and request a fresh one.
            </span>
          </li>
        </ul>

        <div className="space-y-2.5 pt-1">
          <Button asChild className="w-full bg-foreground text-background hover:bg-foreground/90">
            <Link href="/auth/login">Back to sign in</Link>
          </Button>
          <Button variant="outline" asChild className="w-full">
            <Link href="/">Go home</Link>
          </Button>
        </div>

        <p className="border-t border-border pt-4 text-center text-[12px] text-muted-foreground">
          Still stuck? Email{' '}
          <a href="mailto:hello@trysublime.io" className="text-foreground underline underline-offset-4 decoration-foreground/30 hover:decoration-foreground">
            hello@trysublime.io
          </a>
        </p>
      </div>
    </AuthShell>
  )
}
