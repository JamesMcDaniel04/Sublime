-- Add BUSINESS tier and Stripe billing linkage on organizations.
ALTER TYPE "public"."Plan" ADD VALUE 'BUSINESS';

ALTER TABLE "public"."organizations"
  ADD COLUMN "stripeCustomerId" TEXT,
  ADD COLUMN "stripeSubscriptionId" TEXT;

CREATE UNIQUE INDEX "organizations_stripeCustomerId_key" ON "public"."organizations"("stripeCustomerId");
