import { ApiError, withAuthenticatedApi } from '@/lib/server/api-handler'
import { assembleRoiReportData } from '@/lib/goals/report/report-data'
import { renderRoiReport } from '@/lib/goals/report/report-pdf'

export const runtime = 'nodejs'

export const GET = withAuthenticatedApi(async (request, auth) => {
  const rawMonths = request.nextUrl.searchParams.get('months') ?? '3'
  if (!['3', '6', '12'].includes(rawMonths)) {
    throw new ApiError('Months must be 3, 6, or 12.', 400, 'INVALID_REPORT_WINDOW')
  }
  const months = Number(rawMonths) as 3 | 6 | 12
  const data = await assembleRoiReportData({
    organizationId: auth.organizationId,
    viewerUserId: auth.dbUser.id,
    months,
  })
  const pdf = await renderRoiReport(data)
  return new Response(new Uint8Array(pdf), {
    status: 200,
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': 'attachment; filename="sublime-roi-report.pdf"',
      'cache-control': 'private, no-store',
    },
  })
})
