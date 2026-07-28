-- Card-required 14-day trial (spec 2026-07-28).
--
-- trialStartedAt: set once, by the Stripe webhook, when a `trialing`
-- subscription is first observed. Gates trial eligibility at checkout.
-- firstPaidAt: set on the first invoice we collect money on. Splits past_due
-- into "never paid us" (lock out) and "card expired" (grace).
ALTER TABLE "organizations" ADD COLUMN "trialStartedAt" TIMESTAMPTZ(6);
ALTER TABLE "organizations" ADD COLUMN "firstPaidAt" TIMESTAMPTZ(6);

-- MANDATORY BACKFILL — do not split this from the ALTERs above.
--
-- Every org paying us today predates firstPaidAt and would read as NULL. The
-- new dunning rule locks out any past_due org with a NULL firstPaidAt, so
-- without this line the first existing customer whose card expires loses
-- access — exactly the failure the old unconditional past_due grace prevented.
--
-- NOW() rather than "createdAt": the column is only ever tested for NULL, so
-- the instant is immaterial, and NOW() can't later be mistaken for a real
-- first-payment timestamp when debugging.
UPDATE "organizations" SET "firstPaidAt" = NOW() WHERE "plan"::text <> 'TRIAL';
