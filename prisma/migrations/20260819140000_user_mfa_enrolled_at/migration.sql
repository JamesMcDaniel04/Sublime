-- Track when a user first proved AAL2, to gate elevated actions behind MFA.
-- Nullable and default-null so existing users are unaffected until they enroll.
ALTER TABLE "users" ADD COLUMN "mfaEnrolledAt" TIMESTAMPTZ(6);
