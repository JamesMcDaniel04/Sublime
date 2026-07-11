create table "organization_invitations" (
  "id" text primary key,
  "organizationId" uuid not null references "organizations"("id") on delete cascade,
  "email" text not null,
  "role" "UserRole" not null default 'USER',
  "invitedById" text,
  "expiresAt" timestamptz not null,
  "acceptedAt" timestamptz,
  "revokedAt" timestamptz,
  "createdAt" timestamptz not null default now()
);
create index "organization_invitations_organizationId_idx" on "organization_invitations"("organizationId");
create index "organization_invitations_email_idx" on "organization_invitations"("email");
