'use client'

import Link from 'next/link'
import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

export default function AuthCodeErrorPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
      <Card className="max-w-md w-full">
        <CardHeader className="text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <AlertTriangle className="h-6 w-6 text-red-600" />
          </div>
          <CardTitle className="text-2xl font-bold text-gray-900">
            We couldn&apos;t sign you in
          </CardTitle>
          <CardDescription className="text-gray-600">
            This sign-in link is invalid or has expired.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-4">
          <p className="text-sm text-gray-700">
            Sign-in links can only be used once and expire after a short while.
            Head back to the sign-in page to request a fresh one.
          </p>

          <div className="space-y-3">
            <Button asChild className="w-full">
              <Link href="/auth/login">
                Back to sign in
              </Link>
            </Button>

            <Button variant="outline" asChild className="w-full">
              <Link href="/">
                Go home
              </Link>
            </Button>
          </div>

          <div className="text-xs text-gray-500 text-center">
            <p>If this keeps happening, please contact support.</p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
