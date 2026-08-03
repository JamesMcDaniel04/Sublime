-- Lifecycle email send log, in-app feedback, and marketing opt-out.

CREATE TYPE "EmailSendStatus" AS ENUM ('PENDING', 'SENT', 'FAILED');
CREATE TYPE "FeedbackCategory" AS ENUM ('COMPLAINT', 'IDEA', 'QUESTION', 'OTHER');

ALTER TABLE "users" ADD COLUMN "marketingEmailsOptOut" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "email_sends" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT,
    "emailKey" TEXT NOT NULL,
    "dedupeKey" TEXT NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailSendStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "error" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMPTZ(6),
    CONSTRAINT "email_sends_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "email_sends_dedupeKey_key" ON "email_sends"("dedupeKey");
CREATE INDEX "email_sends_organizationId_idx" ON "email_sends"("organizationId");
ALTER TABLE "email_sends" ADD CONSTRAINT "email_sends_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "feedback_submissions" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "category" "FeedbackCategory" NOT NULL,
    "message" TEXT NOT NULL,
    "path" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "feedback_submissions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "feedback_submissions_organizationId_idx" ON "feedback_submissions"("organizationId");
ALTER TABLE "feedback_submissions" ADD CONSTRAINT "feedback_submissions_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
