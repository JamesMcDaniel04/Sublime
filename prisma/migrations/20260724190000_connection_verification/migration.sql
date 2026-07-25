-- Credential/connection verification state, keyed by the flow catalog's
-- connection id (raw cuid | native:x | nango:x | credential:x).
CREATE TABLE "connection_verifications" (
    "organizationId" UUID NOT NULL,
    "connectionId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL,
    "error" TEXT,

    CONSTRAINT "connection_verifications_pkey" PRIMARY KEY ("organizationId", "connectionId")
);
