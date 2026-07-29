-- Global k-anonymous template adoption counts. Replaces the read-time
-- cross-org aggregation in loadTemplateAdoptionScores, which had no
-- k-anonymity floor and silently truncated at 5k events. Rows only exist
-- while >= MIN_ADOPTION_ORGS distinct orgs share the template key; only
-- counts are stored, never org/user/resource identity.
CREATE TABLE "template_adoptions" (
    "templateKey" TEXT NOT NULL,
    "deploys" INTEGER NOT NULL,
    "surviving" INTEGER NOT NULL,
    "orgCount" INTEGER NOT NULL,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "template_adoptions_pkey" PRIMARY KEY ("templateKey")
);
