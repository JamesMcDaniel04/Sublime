import React from 'react'
import {
  Document,
  Page,
  Path,
  renderToBuffer,
  StyleSheet,
  Svg,
  Text,
  View,
} from '@react-pdf/renderer'
import { linePath, scaleLinear } from '@/components/goals/chart-math'
import type { ReportGoal, RoiReportData } from './report-data'

const styles = StyleSheet.create({
  page: { padding: 42, paddingBottom: 56, fontFamily: 'Helvetica', color: '#172033' },
  eyebrow: { fontSize: 9, letterSpacing: 1.4, color: '#6b7280', marginBottom: 8 },
  title: { fontSize: 28, fontWeight: 700, marginBottom: 8 },
  subtitle: { fontSize: 11, color: '#596579', lineHeight: 1.5 },
  section: { marginTop: 24 },
  sectionTitle: { fontSize: 14, fontWeight: 700, marginBottom: 10 },
  figures: { flexDirection: 'row', gap: 10, marginTop: 18 },
  figure: { flexGrow: 1, border: '1 solid #d9deea', borderRadius: 6, padding: 10 },
  tier: { fontSize: 7, textTransform: 'uppercase', color: '#6b7280', marginBottom: 4 },
  value: { fontSize: 17, fontWeight: 700 },
  label: { fontSize: 8, color: '#6b7280', marginTop: 3 },
  goalHeader: { flexDirection: 'row', justifyContent: 'space-between', gap: 16 },
  badge: { fontSize: 8, color: '#374151', border: '1 solid #d9deea', borderRadius: 8, padding: '3 7' },
  chart: { border: '1 solid #e4e7ee', borderRadius: 6, padding: 8, marginTop: 14 },
  row: { flexDirection: 'row', borderBottom: '1 solid #e4e7ee', paddingVertical: 6 },
  cellName: { width: '34%', fontSize: 8 },
  cell: { width: '16.5%', fontSize: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  chip: { fontSize: 8, border: '1 solid #d9deea', borderRadius: 7, padding: '3 6' },
  note: { fontSize: 9, color: '#596579', lineHeight: 1.5 },
  empty: { marginTop: 40, fontSize: 16, color: '#596579' },
  footer: {
    position: 'absolute',
    bottom: 24,
    left: 42,
    right: 42,
    fontSize: 7,
    color: '#7b8494',
    textAlign: 'center',
  },
})

function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  if (seconds < 60) return `${Math.round(seconds)}s`
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`
  return `${(seconds / 3600).toFixed(1)}h`
}

function number(value: number): string {
  return Number(value.toFixed(1)).toLocaleString('en-US')
}

function Footer() {
  return (
    <Text
      fixed
      style={styles.footer}
      render={({ pageNumber, totalPages }) =>
        `Estimates are labeled; correlations are not causation.  ·  ${pageNumber}/${totalPages}`
      }
    />
  )
}

/** Pinned locale + UTC: a board-ready document must not vary by server TZ. */
function reportDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

function Trend({ goal }: { goal: ReportGoal }) {
  const width = 480
  const height = 90
  if (goal.points.length < 2) {
    return <Text style={styles.note}>Not enough readings for a trendline.</Text>
  }
  // Domain spans the goal window ∪ readings so the pace line (start → target)
  // is always drawable — the spec's chart is "trendline + pace line".
  const minTime = Math.min(goal.points[0].capturedAt.getTime(), goal.startAt.getTime())
  const maxTime = Math.max(goal.points.at(-1)!.capturedAt.getTime(), goal.targetDate.getTime())
  const values = goal.points.map((point) => point.value)
  const minValue = Math.min(...values, goal.targetValue, goal.startValue)
  const maxValue = Math.max(...values, goal.targetValue, goal.startValue)
  const x = scaleLinear([minTime, maxTime], [4, width - 4])
  const y = scaleLinear([minValue, maxValue], [height - 4, 4])
  const path = linePath(
    goal.points.map((point) => ({ x: x(point.capturedAt.getTime()), y: y(point.value) })),
  )
  const pacePath = linePath([
    { x: x(goal.startAt.getTime()), y: y(goal.startValue) },
    { x: x(goal.targetDate.getTime()), y: y(goal.targetValue) },
  ])
  return (
    <Svg width={width} height={height}>
      <Path d={pacePath} stroke="#9aa1ad" strokeWidth={1} strokeDasharray="4 3" fill="none" />
      <Path d={path} stroke="#6558d3" strokeWidth={2} fill="none" />
    </Svg>
  )
}

function GoalPage({ goal }: { goal: ReportGoal }) {
  return (
    <Page size="LETTER" style={styles.page}>
      <View style={styles.goalHeader}>
        <View>
          <Text style={styles.eyebrow}>GOAL OUTCOME</Text>
          <Text style={styles.title}>{goal.name}</Text>
          <Text style={styles.subtitle}>
            Current {goal.currentValue === null ? '—' : number(goal.currentValue)} · target{' '}
            {number(goal.targetValue)} · expected progress {Math.round(goal.expectedProgress * 100)}%
          </Text>
        </View>
        <Text style={styles.badge}>{goal.riskLevel.replace('_', ' ')}</Text>
      </View>

      <View style={styles.chart}>
        <Trend goal={goal} />
      </View>

      <View style={styles.figures}>
        <View style={styles.figure}>
          <Text style={styles.tier}>Measured</Text>
          <Text style={styles.value}>{goal.impact.measured.runsCompleted}</Text>
          <Text style={styles.label}>completed AI actions</Text>
        </View>
        <View style={styles.figure}>
          <Text style={styles.tier}>Measured</Text>
          <Text style={styles.value}>{duration(goal.impact.measured.aiRunSecondsTotal)}</Text>
          <Text style={styles.label}>AI run time</Text>
        </View>
        <View style={styles.figure}>
          <Text style={styles.tier}>Estimated</Text>
          <Text style={styles.value}>{goal.impact.estimated.hoursSaved.toFixed(1)}h</Text>
          <Text style={styles.label}>manual time saved</Text>
        </View>
        <View style={styles.figure}>
          <Text style={styles.tier}>Correlated</Text>
          <Text style={styles.value}>
            {goal.paceDeltaPct === null ? '—' : `${goal.paceDeltaPct.toFixed(0)}%`}
          </Text>
          <Text style={styles.label}>pace change after attribution</Text>
        </View>
      </View>

      {goal.periods.length > 0 && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>Period history</Text>
          <View style={styles.chips}>
            {goal.periods.map((period) => (
              <Text key={period.periodEnd.toISOString()} style={styles.chip}>
                {/* periodEnd is exclusive — label the window that ENDED. */}
                {new Date(period.periodEnd.getTime() - 24 * 60 * 60 * 1000).toLocaleDateString(
                  'en-US',
                  { month: 'short', year: 'numeric', timeZone: 'UTC' },
                )}{' '}
                {period.outcome === 'achieved' ? 'achieved' : 'missed'}
              </Text>
            ))}
          </View>
        </View>
      )}

      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Contributing automations</Text>
        {goal.contributions.length === 0 ? (
          <Text style={styles.note}>No automations attributed in this window.</Text>
        ) : (
          <>
            <View style={styles.row}>
              <Text style={styles.cellName}>Automation</Text>
              <Text style={styles.cell}>Origin</Text>
              <Text style={styles.cell}>Runs</Text>
              <Text style={styles.cell}>Avg AI time</Text>
              <Text style={styles.cell}>Est. min/run</Text>
            </View>
            {goal.contributions.map((contribution, index) => (
              <View key={`${contribution.name}-${index}`} style={styles.row}>
                <Text style={styles.cellName}>{contribution.name}</Text>
                <Text style={styles.cell}>{contribution.origin}</Text>
                <Text style={styles.cell}>{contribution.runs}</Text>
                <Text style={styles.cell}>{duration(contribution.avgRunSeconds)}</Text>
                <Text style={styles.cell}>{contribution.estimatedMinutesSavedPerRun}</Text>
              </View>
            ))}
          </>
        )}
      </View>
      <Footer />
    </Page>
  )
}

export function RoiReportDocument({ data }: { data: RoiReportData }) {
  return (
    <Document title="Sublime ROI Report" author="Sublime">
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.eyebrow}>SUBLIME ROI REPORT</Text>
        <Text style={styles.title}>{data.organizationName}</Text>
        <Text style={styles.subtitle}>
          {reportDate(data.windowStart)} – {reportDate(data.generatedAt)} · generated{' '}
          {reportDate(data.generatedAt)}
        </Text>
        <View style={styles.figures}>
          <View style={styles.figure}>
            <Text style={styles.tier}>Measured</Text>
            <Text style={styles.value}>{data.impact.measured.runsCompleted}</Text>
            <Text style={styles.label}>completed attributed runs</Text>
          </View>
          <View style={styles.figure}>
            <Text style={styles.tier}>Estimated</Text>
            <Text style={styles.value}>${Math.round(data.impact.estimated.laborValueUsd).toLocaleString()}</Text>
            <Text style={styles.label}>labor value created</Text>
          </View>
          <View style={styles.figure}>
            <Text style={styles.tier}>Correlated</Text>
            <Text style={styles.value}>{data.goals.filter((goal) => goal.paceDeltaPct !== null).length}</Text>
            <Text style={styles.label}>goals with observable pace comparison</Text>
          </View>
        </View>
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>How to read this report</Text>
          <Text style={styles.note}>
            Measured figures come from completed automation runs and their execution durations.
            Estimated figures use editable manual-time assumptions. Correlated figures compare
            goal pace before and after attribution and do not prove causation.
          </Text>
        </View>
        {data.goals.length === 0 && (
          <Text style={styles.empty}>No goals tracked yet</Text>
        )}
        <Footer />
      </Page>
      {data.goals.map((goal) => <GoalPage key={goal.id} goal={goal} />)}
    </Document>
  )
}

export async function renderRoiReport(data: RoiReportData): Promise<Buffer> {
  return renderToBuffer(<RoiReportDocument data={data} />)
}
