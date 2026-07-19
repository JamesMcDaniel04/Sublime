# Supabase auth email setup

Branded transactional email templates for Supabase Auth, plus the dashboard
configuration that makes email confirmation log users in automatically and
makes mail come from `hello@trysublime.io`.

## Why these templates exist (the auto-login fix)

Supabase's default templates link through `{{ .ConfirmationURL }}`, which uses
a PKCE code that only works in the exact browser that started the signup — open
the email on your phone (or in a different browser) and you land logged-out or
on an error page. These templates instead link straight to our own
`/auth/callback` with a `token_hash`. The server verifies it with `verifyOtp`,
sets the session cookie, and redirects into the app — **clicking the email
confirms AND signs the user in, from any browser or device.**

## 1. Paste the templates

Supabase Dashboard → **Authentication → Emails** (templates tab). For each
template, paste the corresponding file's full HTML into the *Message body*
(source view) and set the subject:

| Supabase template  | File                  | Suggested subject                  |
| ------------------ | --------------------- | ---------------------------------- |
| Confirm signup     | `confirm-signup.html` | Confirm your email — Sublime       |
| Magic Link         | `magic-link.html`     | Your Sublime sign-in link          |
| Reset Password     | `reset-password.html` | Reset your Sublime password        |
| Invite user        | `invite.html`         | You've been invited to Sublime     |

Note on links: the confirm-signup template uses `{{ .RedirectTo }}` so a signup
that started from a pricing card continues to checkout after confirming (the
app always passes `emailRedirectTo=/auth/callback?next=…`). The other templates
use `{{ .SiteURL }}/auth/callback?…`, which works even when no redirect was
passed (e.g. invites sent from the Supabase dashboard).

## 2. URL configuration (required for the links to work)

Dashboard → **Authentication → URL Configuration**:

- **Site URL**: `https://www.trysublime.io`
- **Redirect URLs** (add all):
  - `https://www.trysublime.io/auth/callback`
  - `https://trysublime.io/auth/callback`
  - `http://localhost:3000/auth/callback` (local dev)

## 3. Send from hello@trysublime.io (custom SMTP)

The built-in mailer always sends from `noreply@mail.app.supabase.io` and is
rate-limited to a handful of emails per hour — production must use custom SMTP.

1. Pick a transactional email provider (Resend is the usual choice; Postmark,
   SendGrid, and SES also work) and create an account.
2. In the provider, **verify the `trysublime.io` domain**: add the SPF and DKIM
   DNS records it gives you at your DNS host. Wait for verification (usually
   minutes).
3. Create an SMTP credential in the provider (for Resend: SMTP host
   `smtp.resend.com`, port `465`, username `resend`, password = an API key).
4. Supabase Dashboard → **Project Settings → Authentication → SMTP Settings**
   (toggle *Enable Custom SMTP*) and fill in:
   - **Sender email**: `hello@trysublime.io`
   - **Sender name**: `Sublime`
   - Host / port / username / password: from step 3
5. Send yourself a test signup email and confirm it arrives from
   `Sublime <hello@trysublime.io>` and doesn't hit spam.

Also bump **Authentication → Rate Limits → Email** (default is very low) once
custom SMTP is on.

## 4. Verify end-to-end

1. Sign up with a fresh email address.
2. Open the confirmation email **in a different browser** than the signup.
3. Clicking the button should land you in `/dashboard` fully signed in.
