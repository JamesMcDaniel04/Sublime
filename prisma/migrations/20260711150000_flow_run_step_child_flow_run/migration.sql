-- Task 8: synchronous subflow node. Links a subflow step's FlowRunStep row to
-- the child FlowRun it executed, mirroring agentExecutionId for agent steps.
ALTER TABLE "flow_run_steps" ADD COLUMN "childFlowRunId" TEXT;
