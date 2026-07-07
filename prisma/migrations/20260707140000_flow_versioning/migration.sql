-- Draft-vs-published versioning + per-run definition snapshots.
ALTER TABLE "flows" ADD COLUMN "publishedGraph" JSONB;
ALTER TABLE "flows" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "flow_runs" ADD COLUMN "graphSnapshot" JSONB;
