-- Remove the Signals and Approvals features: the signal ingestion/routing
-- tables, the signal linkage on agent executions, and the outbound-write
-- approval queue. Destructive by design — these features were removed from
-- the product.

-- DropForeignKey
ALTER TABLE "agent_executions" DROP CONSTRAINT IF EXISTS "agent_executions_signalId_fkey";

-- AlterTable
ALTER TABLE "agent_executions" DROP COLUMN IF EXISTS "signalId";

-- DropTable
DROP TABLE IF EXISTS "approval_requests";

-- DropTable
DROP TABLE IF EXISTS "signal_subscriptions";

-- DropTable
DROP TABLE IF EXISTS "signals";
