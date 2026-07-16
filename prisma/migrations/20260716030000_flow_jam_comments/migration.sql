-- Flow Jam social layer (Spec 3): threaded comments anchored to a flow node
-- (or unanchored for flow-level discussion). Replies reference the root
-- comment via parentId; resolving keeps the row so threads can be reopened.
CREATE TABLE "flow_comments" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" TEXT NOT NULL,
    "parentId" TEXT,
    "anchorNodeId" TEXT,
    "body" TEXT NOT NULL,
    "resolvedAt" TIMESTAMPTZ(6),
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "flow_comments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "flow_comments_flowId_createdAt_idx" ON "flow_comments"("flowId", "createdAt");

CREATE INDEX "flow_comments_organizationId_flowId_idx" ON "flow_comments"("organizationId", "flowId");

ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "flows"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "flow_comments" ADD CONSTRAINT "flow_comments_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "flow_comments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
