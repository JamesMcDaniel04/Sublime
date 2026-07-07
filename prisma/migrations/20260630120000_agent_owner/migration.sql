-- AlterTable
ALTER TABLE "agent_tasks" ADD COLUMN "userId" TEXT;

-- CreateIndex
CREATE INDEX "agent_tasks_userId_idx" ON "agent_tasks"("userId");

-- AddForeignKey
ALTER TABLE "agent_tasks" ADD CONSTRAINT "agent_tasks_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
