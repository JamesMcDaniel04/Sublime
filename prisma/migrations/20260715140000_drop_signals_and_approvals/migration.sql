-- Remove the Signals and Approvals features and the Klavis connector plane:
-- the signal ingestion/routing tables, the signal linkage on agent
-- executions, the outbound-write approval queue, and the Klavis-provisioned
-- MCP server mirror table. Destructive by design — these features were
-- removed from the product.

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

-- DropTable
DROP TABLE IF EXISTS "mcp_agents";
