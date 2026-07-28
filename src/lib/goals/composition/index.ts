/**
 * Per-kind goal composition (spec 2026-07-28). One entry point so consumers
 * import from '@/lib/goals/composition' rather than reaching into modules.
 */
export {
  ARR_OPTIONAL_SLOTS,
  ARR_REQUIRED_SLOTS,
  rollupArr,
  type ArrRollup,
} from './rollup-arr'
export {
  DEFAULT_COVERAGE_THRESHOLD,
  QUOTA_GATE_SLOTS,
  rollupQuota,
  type GateFinding,
  type QuotaRollup,
} from './rollup-quota'
export {
  kpiRequiredSlots,
  rollupKpi,
  type KpiConfig,
  type KpiRollup,
  type KpiShape,
} from './rollup-kpi'
export {
  DEFAULT_TOLERANCE_PCT,
  reconcile,
  type ReconcileStatus,
} from './reconcile'
export {
  compositionCompleteness,
  type CompletenessLevel,
  type CompletenessResult,
} from './completeness'
export { RISK_SEVERITY, applyCompositionGates } from './gates'
export {
  compositionRequiredSlots,
  evaluateComposite,
  parseCompositionSpec,
  type ComponentReading,
  type CompositionSpec,
  type CompositionState,
} from './evaluate-composite'
