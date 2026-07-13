CREATE TABLE "flow_collaborators" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "invitedById" TEXT,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "flow_collaborators_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "flow_collaborators_flowId_userId_key"
    ON "flow_collaborators"("flowId", "userId");
CREATE INDEX "flow_collaborators_organizationId_userId_idx"
    ON "flow_collaborators"("organizationId", "userId");

ALTER TABLE "flow_collaborators"
    ADD CONSTRAINT "flow_collaborators_flowId_fkey"
    FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_collaborators"
    ADD CONSTRAINT "flow_collaborators_organizationId_fkey"
    FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_collaborators"
    ADD CONSTRAINT "flow_collaborators_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "flow_collaborators"
    ADD CONSTRAINT "flow_collaborators_invitedById_fkey"
    FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
