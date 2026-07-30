'use client'

import { useRef, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { resizeImageToDataUrl } from '@/lib/client/resize-image'
import type { Profile } from './types'

/** PATCH /api/settings/profile caps imageUrl at 2048 characters. */
const AVATAR_URL_MAX = 2048

/**
 * Downscale an uploaded photo to a small square data URL that fits the
 * profile imageUrl limit: PNG first (crispest), then increasingly compact
 * JPEGs until one fits.
 */
async function fileToAvatarDataUrl(file: File): Promise<string> {
  const attempts: Array<{ size: number; mimeType: 'image/png' | 'image/jpeg'; quality?: number }> = [
    { size: 64, mimeType: 'image/png' },
    { size: 64, mimeType: 'image/jpeg', quality: 0.8 },
    { size: 48, mimeType: 'image/jpeg', quality: 0.7 },
    { size: 32, mimeType: 'image/jpeg', quality: 0.6 },
    { size: 24, mimeType: 'image/jpeg', quality: 0.5 },
  ]
  for (const { size, mimeType, quality } of attempts) {
    const dataUrl = await resizeImageToDataUrl(file, size, { mimeType, quality })
    if (dataUrl.length <= AVATAR_URL_MAX) return dataUrl
  }
  throw new Error('Could not shrink that image enough — try a simpler one.')
}

export function ProfileTab({
  profile,
  setProfile,
  savedProfileName,
  onSavedName,
}: Readonly<{
  profile: Profile
  setProfile: (updater: (current: Profile | null) => Profile | null) => void
  savedProfileName: string
  onSavedName: (name: string) => void
}>) {
  const supabase = createClient()
  const [savingAvatar, setSavingAvatar] = useState(false)
  const avatarInputRef = useRef<HTMLInputElement>(null)

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault()
    const name = profile.name?.trim()
    if (!name || name === savedProfileName) return
    const response = await fetch('/api/settings/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, name }) })
    const data = await response.json()
    if (!response.ok) return toast.error(data.error || 'Could not save profile')
    setProfile(() => data.profile)
    onSavedName(data.profile?.name || name)
    toast.success('Profile saved')
  }

  /** PATCH just the photo, keeping the last-saved name (the schema requires one). */
  async function saveAvatar(imageUrl: string | null) {
    const name = savedProfileName.trim() || profile.name?.trim()
    if (!name) return toast.error('Set a display name before adding a photo.')
    setSavingAvatar(true)
    try {
      const response = await fetch('/api/settings/profile', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, imageUrl }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) return toast.error(data.error || 'Could not update your photo')
      // Merge instead of replacing so an in-progress name edit isn't clobbered.
      setProfile((current) => (current ? { ...current, imageUrl: data.profile?.imageUrl ?? imageUrl } : current))
      toast.success(imageUrl ? 'Photo updated' : 'Photo removed')
    } finally {
      setSavingAvatar(false)
    }
  }

  async function uploadAvatar(file: File) {
    setSavingAvatar(true)
    try {
      const imageUrl = await fileToAvatarDataUrl(file)
      await saveAvatar(imageUrl)
    } catch (cause) {
      toast.error(cause instanceof Error && cause.message ? cause.message : 'Could not read that image — try a PNG or JPEG.')
    } finally {
      setSavingAvatar(false)
    }
  }

  return (
    <>
      <Card className="max-w-2xl"><CardHeader><CardTitle>Profile</CardTitle></CardHeader><CardContent><form className="space-y-4" onSubmit={saveProfile}>
        <div className="flex items-center gap-4">
          {profile.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={profile.imageUrl} alt="Profile photo" className="h-14 w-14 rounded-full border object-cover" />
          ) : (
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-muted text-lg font-semibold text-muted-foreground" aria-hidden>
              {(profile.name || profile.email || 'U').trim().charAt(0).toUpperCase()}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" loading={savingAvatar} onClick={() => avatarInputRef.current?.click()}>
              {profile.imageUrl ? 'Change photo' : 'Upload photo'}
            </Button>
            {profile.imageUrl && (
              <Button type="button" variant="ghost" size="sm" disabled={savingAvatar} onClick={() => void saveAvatar(null)}>Remove</Button>
            )}
          </div>
          <input
            ref={avatarInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void uploadAvatar(file) }}
          />
        </div>
        <div className="space-y-2"><Label htmlFor="name">Display name</Label><Input id="name" value={profile.name || ''} onChange={(e) => setProfile((current) => (current ? { ...current, name: e.target.value } : current))} /></div>
        <Button type="submit" disabled={!profile.name?.trim() || profile.name.trim() === savedProfileName}>Save profile</Button>
      </form></CardContent></Card>
      <Card className="mt-6 max-w-2xl border-destructive/30"><CardHeader><CardTitle>Delete account</CardTitle></CardHeader><CardContent><p className="mb-4 text-sm text-muted-foreground">Permanently removes your account. If you are the only member, the workspace and its data are also deleted.</p><Button variant="outline" className="border-destructive/30 text-destructive hover:bg-destructive/10 hover:text-destructive" onClick={async () => { if (window.prompt('Type DELETE to permanently delete your account') !== 'DELETE') return; const response = await fetch('/api/settings/profile', { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmation: 'DELETE' }) }); const data = await response.json(); if (!response.ok) return toast.error(data.error || 'Could not delete account'); await supabase.auth.signOut(); window.location.replace('/') }}>Delete account</Button></CardContent></Card>
    </>
  )
}
