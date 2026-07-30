/**
 * Shapes shared between the settings shell (which loads them once) and the tab
 * components (which render and mutate them). One load, many consumers: profile
 * gates admin-only tabs, members feed both the Members tab and (later) the
 * takeover flow, org settings feed Workspace and Billing.
 */

export type Profile = { name: string; email: string; imageUrl: string | null; role: string }

export type Member = {
  id: string
  email: string | null
  name: string | null
  role: 'ADMIN' | 'MEMBER'
  isActive: boolean
}

export type Invitation = {
  id: string
  email: string
  role: 'ADMIN' | 'MEMBER'
  expiresAt: string
  createdAt: string
}

export type OrgSettings = {
  disableConnectionScans?: boolean
  knowledgeCaptureEnabled?: boolean
  captureAgentRunKnowledge?: boolean
  captureFlowRunKnowledge?: boolean
  captureConnectedKnowledge?: boolean
  retainKnowledgeOnDisconnect?: boolean
  zeroDataRetention?: boolean
}
