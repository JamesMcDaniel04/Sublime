-- CreateTable
CREATE TABLE "public"."credit_grants" (
    "id" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "credits" INTEGER NOT NULL,
    "month" TEXT NOT NULL,
    "reason" TEXT NOT NULL DEFAULT 'topup',
    "stripeRef" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "credit_grants_stripeRef_key" ON "public"."credit_grants"("stripeRef");

-- CreateIndex
CREATE INDEX "credit_grants_organizationId_month_idx" ON "public"."credit_grants"("organizationId", "month");

-- AddForeignKey
ALTER TABLE "public"."credit_grants" ADD CONSTRAINT "credit_grants_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "public"."organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
