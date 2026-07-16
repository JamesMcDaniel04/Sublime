-- Flow Jam comments: free canvas-point pins ({ space: 'dag'|'stack', x, y } in
-- canvas coordinates) alongside the existing node anchors. Same coordinate
-- spaces the Jam cursors already broadcast in.
ALTER TABLE "flow_comments" ADD COLUMN "anchorPoint" JSONB;
