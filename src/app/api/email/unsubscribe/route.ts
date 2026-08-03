import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/prisma'
import { verifyUnsubscribeToken } from '@/lib/email/unsubscribe'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const uid = request.nextUrl.searchParams.get('uid') || ''
  const signature = request.nextUrl.searchParams.get('sig') || ''
  const page = (title: string, body: string, status: number) => new NextResponse(
    `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:sans-serif;max-width:480px;margin:80px auto;padding:0 16px"><h1 style="font-size:20px">${title}</h1><p>${body}</p></body>`,
    { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  )
  if (!verifyUnsubscribeToken(uid, signature)) {
    return page('Invalid link', 'This unsubscribe link is not valid. You can manage email in Settings instead.', 400)
  }
  await prisma.user.updateMany({ where: { id: uid }, data: { marketingEmailsOptOut: true } })
  return page('You are unsubscribed', 'You will no longer receive marketing email from Sublime. Transactional billing and security email still sends.', 200)
}
