-- Bug-A fix: a loop-body step's iteration path (outermost -> innermost
-- 0-based indices, dot-joined) disambiguates the SAME node id executing once
-- per iteration — without it, resume's flat nodeId -> output map collapses
-- every iteration to the last write. Null for any step outside a loop body.
ALTER TABLE "flow_run_steps" ADD COLUMN "iterationPath" TEXT;
