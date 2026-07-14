'use client'

import { createContext, useContext } from 'react'
import type { ToolCatalog } from './tool-catalog-type'
import type { ConnectResult } from '@/lib/client/use-connect-provider'

/**
 * Connect-first plumbing for the flow builder's "browse available connectors"
 * picker. Provided once at the flow page and consumed by FlowPicker (which is
 * nested behind several InsertMenus), so picking a not-yet-connected tool can
 * connect the provider and refresh the catalog without prop-drilling.
 */
export type FlowConnectValue = {
  /** Connect a not-yet-connected provider (from a catalog entry's `connect`). */
  connectProvider: (provider: string) => Promise<ConnectResult>
  /** Re-pull the tool catalog after a connect; resolves to the fresh catalog. */
  refreshToolCatalog: () => Promise<ToolCatalog>
}

const FlowConnectContext = createContext<FlowConnectValue | null>(null)

export const FlowConnectProvider = FlowConnectContext.Provider

/** Null when no provider is mounted (e.g. tests) — callers degrade gracefully. */
export function useFlowConnect(): FlowConnectValue | null {
  return useContext(FlowConnectContext)
}
