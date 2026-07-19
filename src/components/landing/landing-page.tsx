'use client'

/* eslint-disable @next/next/no-img-element */

// Ported from the Lovable-built Sublime-Landing-Page repo (src/pages/Landing.tsx).
// Differences from the source: next/link instead of react-router, a locally
// scoped theme (the `.lovable-landing` wrapper carries its own `.dark` class so
// the toggle never restyles the product or auth pages), images served from
// /public/landing, and the 3D logo loaded client-only.
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { ArrowRight, Moon, Sun } from 'lucide-react'
import { useEffect, useState } from 'react'
import { StackedLogo } from './stacked-logo'
import { PricingGrid } from '@/components/billing/pricing-grid'

const Logo3D = dynamic(() => import('./logo3d').then((m) => m.Logo3D), { ssr: false })

const testimonialAvatar = '/landing/testimonial-avatar.jpg'
const agentsShot = '/landing/sublime-agents.png'
const integrationsShot = '/landing/sublime-integrations.png'
const flowsShot = '/landing/sublime-flows.png'

// Slack/Salesforce/Teams/Amplitude were delisted from the Simple Icons CDN
// (brand takedowns) — bundled or dropped rather than 404ing in the marquee.
const INTEGRATION_LOGOS = [
  { name: 'Salesforce', src: '/logos/salesforce.svg' },
  { name: 'Slack', src: '/logos/slack.svg' },
  { name: 'Google Drive', src: 'https://cdn.simpleicons.org/googledrive' },
  { name: 'Google Sheets', src: 'https://cdn.simpleicons.org/googlesheets' },
  { name: 'Google Docs', src: 'https://cdn.simpleicons.org/googledocs' },
  { name: 'Google Calendar', src: 'https://cdn.simpleicons.org/googlecalendar' },
  { name: 'Gmail', src: 'https://cdn.simpleicons.org/gmail' },
  { name: 'HubSpot', src: 'https://cdn.simpleicons.org/hubspot' },
  { name: 'Notion', src: 'https://cdn.simpleicons.org/notion' },
  { name: 'Linear', src: 'https://cdn.simpleicons.org/linear' },
  { name: 'Jira', src: 'https://cdn.simpleicons.org/jira' },
  { name: 'Asana', src: 'https://cdn.simpleicons.org/asana' },
  { name: 'GitHub', src: 'https://cdn.simpleicons.org/github' },
  { name: 'GitLab', src: 'https://cdn.simpleicons.org/gitlab' },
  { name: 'Zendesk', src: 'https://cdn.simpleicons.org/zendesk' },
  { name: 'Intercom', src: 'https://cdn.simpleicons.org/intercom' },
  { name: 'Snowflake', src: 'https://cdn.simpleicons.org/snowflake' },
  { name: 'Airtable', src: 'https://cdn.simpleicons.org/airtable' },
  { name: 'Supabase', src: 'https://cdn.simpleicons.org/supabase' },
  { name: 'PostHog', src: 'https://cdn.simpleicons.org/posthog' },
  { name: 'ClickUp', src: 'https://cdn.simpleicons.org/clickup' },
  { name: 'Confluence', src: 'https://cdn.simpleicons.org/confluence' },
  { name: 'Hugging Face', src: 'https://cdn.simpleicons.org/huggingface' },
  { name: 'Figma', src: '/logos/figma.svg' },
]

const LOGO_VARIANT = 1
const CUBE_SIZE = 840
const CUBE_OFFSET_X = -140
const CUBE_OFFSET_Y = -80

const THEME_STORAGE_KEY = 'sublime-landing-theme'

type Shot = { src: string; alt: string; label: string }

function CollaborationCursors() {
  const cursors = [
    { name: 'Maya', color: '#7c3aed', left: '43%', top: '48%', rotate: '-8deg' },
    { name: 'Alex', color: '#ea580c', left: '67%', top: '65%', rotate: '7deg' },
  ]
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 top-7 z-20" aria-hidden="true">
      {cursors.map((cursor) => (
        <div
          key={cursor.name}
          className="absolute flex items-start drop-shadow-[0_3px_6px_rgba(0,0,0,0.3)]"
          style={{ left: cursor.left, top: cursor.top, transform: `rotate(${cursor.rotate})` }}
        >
          <svg width="22" height="27" viewBox="0 0 22 27" fill="none" className="h-5 w-4 md:h-7 md:w-[22px]">
            <path d="M2 1.8V22l5.4-5.1 3.7 8.1 3.5-1.7-3.8-7.8H20L2 1.8Z" fill={cursor.color} stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
          </svg>
          <span className="-ml-0.5 mt-4 whitespace-nowrap rounded px-1.5 py-0.5 text-[7px] font-semibold text-white md:mt-5 md:px-2 md:text-[10px]" style={{ backgroundColor: cursor.color }}>
            {cursor.name}
          </span>
        </div>
      ))}
    </div>
  )
}

const InteractiveShowcase = ({ shots }: { shots: Shot[] }) => {
  const [tilt, setTilt] = useState({ x: 0, y: 0 })
  const [active, setActive] = useState<string>(shots[0]?.label ?? '')

  const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect()
    const px = (e.clientX - rect.left) / rect.width - 0.5
    const py = (e.clientY - rect.top) / rect.height - 0.5
    setTilt({ x: px, y: py })
  }
  const reset = () => setTilt({ x: 0, y: 0 })

  return (
    <div
      className="relative mt-20 h-[760px] hidden md:block"
      style={{ perspective: '2400px', perspectiveOrigin: '50% 50%' }}
      onMouseMove={handleMove}
      onMouseLeave={reset}
    >
      <div
        className="absolute inset-0 flex items-center justify-center"
        style={{
          transformStyle: 'preserve-3d',
          transform: `rotateY(${tilt.x * 4}deg) rotateX(${-tilt.y * 3}deg)`,
          transition: 'transform 260ms cubic-bezier(0.2, 0.8, 0.2, 1)',
        }}
      >
        {shots.map((shot, i) => {
          const isActive = active === shot.label
          const activeIndex = shots.findIndex((s) => s.label === active)
          // position non-active shots to the sides based on their relative index
          const rel = i - activeIndex
          const sideOffset = rel === 0 ? 0 : rel < 0 ? -1 : 1
          // among non-active, stack by distance
          const sideDepth = Math.abs(rel)
          const baseX = sideOffset * 520 + (rel !== 0 && sideDepth > 1 ? sideOffset * 40 : 0)
          const baseRotY = sideOffset * -28
          const parallaxX = tilt.x * 18
          const parallaxY = tilt.y * 12

          return (
            <div
              key={shot.label}
              onClick={() => setActive(shot.label)}
              className="absolute rounded-xl border border-border bg-card overflow-hidden cursor-pointer"
              style={{
                width: isActive ? 1080 : 520,
                zIndex: isActive ? 30 : 10 - sideDepth,
                transformOrigin: 'center center',
                transform: isActive
                  ? `translate3d(${parallaxX * 0.4}px, ${parallaxY * 0.4}px, 260px) rotateY(0deg) rotateX(0deg)`
                  : `translate3d(${baseX + parallaxX}px, ${parallaxY}px, ${-sideDepth * 80}px) rotateY(${baseRotY}deg) rotateX(4deg) scale(0.85)`,
                transformStyle: 'preserve-3d',
                transition: 'transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1), width 600ms cubic-bezier(0.2, 0.8, 0.2, 1), opacity 400ms, filter 400ms, box-shadow 400ms',
                opacity: isActive ? 1 : 0.5,
                filter: isActive ? 'none' : 'blur(1.5px)',
                boxShadow: isActive
                  ? '0 100px 160px -30px rgba(0,0,0,0.7), 0 0 0 1px hsl(var(--primary) / 0.5)'
                  : '0 40px 80px -20px rgba(0,0,0,0.4), 0 0 0 1px hsl(var(--border))',
              }}
            >
              <div className="flex items-center gap-1.5 px-3 h-7 border-b border-border bg-muted/40">
                <div className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                <div className="h-2.5 w-2.5 rounded-full bg-warning/60" />
                <div className="h-2.5 w-2.5 rounded-full bg-success/60" />
                <span className="ml-3 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{shot.label}</span>
              </div>
              <img src={shot.src} alt={shot.alt} className="w-full h-auto block pointer-events-none" loading="lazy" draggable={false} />
              {shot.label === 'Collaborative Flows' && <CollaborationCursors />}
            </div>
          )
        })}
      </div>
      <div className="absolute -bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-2">
        {shots.map((s) => (
          <button
            key={s.label}
            onClick={() => setActive(s.label)}
            className={`px-3 py-1.5 text-[11px] uppercase tracking-[0.15em] border transition-colors ${
              active === s.label
                ? 'border-foreground text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  )
}

export function LandingPage({ fontClassName = '' }: { fontClassName?: string }) {
  const [theme, setThemeState] = useState<'light' | 'dark'>('dark')
  const [cubeZoom, setCubeZoom] = useState(360)

  useEffect(() => {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY)
    if (stored === 'light' || stored === 'dark') setThemeState(stored)

    const handleResize = () => {
      setCubeZoom(window.innerWidth < 1024 ? 270 : 360)
    }
    handleResize()
    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [])

  const setTheme = (next: 'light' | 'dark') => {
    setThemeState(next)
    window.localStorage.setItem(THEME_STORAGE_KEY, next)
  }

  const isDark = theme === 'dark'
  const diagonalLineColor = isDark ? 'hsl(240 4% 26%' : 'hsl(240 4% 80%'

  return (
    <div className={`lovable-landing ${fontClassName} ${isDark ? 'dark' : ''} min-h-screen bg-background text-foreground overflow-x-hidden`}>
      {/* Nav */}
      <nav className="fixed top-0 z-50 w-full bg-background border-b border-border px-6">
        <div className="mx-auto flex h-[56px] max-w-[1200px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2 -ml-0.5">
            <StackedLogo size={16} />
            <span className="text-[14px] font-bold text-foreground tracking-[0.08em] uppercase">Sublime</span>
          </Link>
          <div className="flex items-center gap-2">
            <Link href="/#pricing" className="text-[13px] text-foreground/70 hover:text-foreground transition-colors h-8 px-3 flex items-center">
              Pricing
            </Link>
            <button
              onClick={() => setTheme(isDark ? 'light' : 'dark')}
              className="relative h-8 w-8 flex items-center justify-center text-foreground/70 hover:text-foreground transition-colors"
              title="Toggle theme"
            >
              <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
              <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
            </button>
            <Link href="/auth/login">
              <button className="text-[13px] text-foreground/70 hover:text-foreground transition-colors h-8 px-3">
                Log in
              </button>
            </Link>
            <Link href="/auth/signup">
              <button className="text-[13px] h-8 px-3 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background transition-colors">
                Sign up
              </button>
            </Link>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <section className="relative z-10 pt-16 pb-0 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] relative">
          {/* Two-column hero: text left, cube right */}
          <div className="pt-[52px] pb-16 relative flex">
            {/* Left column — text */}
            <div className="relative z-[3] flex-1 min-w-0 max-w-[540px]">
              <h1 className="text-[clamp(2rem,4vw,3.2rem)] font-[500] leading-[1.08] tracking-[-0.04em] text-foreground max-w-[540px]">
                AI that knows your business
              </h1>
              <p className="mt-6 text-base leading-relaxed text-muted-foreground max-w-[420px]">
                Connect the tools your team already uses. Sublime reconstructs how work gets done, then powers agents and workflows that deliver useful outcomes from day one.
              </p>
              <div className="mt-10 flex items-center gap-4">
                <Link href="/auth/signup">
                  <button className="group relative inline-flex items-center gap-2 px-6 py-3 text-[14px] font-medium bg-foreground text-background transition-all duration-200 hover:bg-foreground/90">
                    Start building
                    <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" />
                  </button>
                </Link>
              </div>
            </div>

            {/* Right column — 3D cube */}
            <div className="hidden md:block flex-1 relative z-[1] pointer-events-none" style={{ minWidth: 0 }}>
              <div className="absolute top-1/2 right-0 -translate-y-1/2" style={{ width: CUBE_SIZE, height: CUBE_SIZE, transform: `translate(${-CUBE_OFFSET_X}px, calc(-50% + ${CUBE_OFFSET_Y}px))` }}>
                <Logo3D variant={LOGO_VARIANT} size={CUBE_SIZE} zoom={cubeZoom} bgHex={isDark ? '#0e0e10' : '#ffffff'} lineHex={isDark ? '#58585e' : '#c0c0c8'} />
              </div>
            </div>
          </div>

          <div className="relative" style={{ overflow: 'visible' }}>
            <div className="relative z-10 rounded-t-xl border border-b-0 border-border bg-card overflow-hidden">
              <div className="flex min-h-[420px]">
                {/* Sidebar mock */}
                <div className="w-[200px] border-r border-border p-3 flex flex-col gap-1 shrink-0">
                  <div className="flex items-center gap-2 px-2 h-8 mb-2">
                    <div className="h-4 w-4 rounded bg-primary/30" />
                    <div className="h-2 w-16 rounded-full bg-foreground/15" />
                  </div>
                  <div className="h-px bg-border" />
                  {['w-20', 'w-16', 'w-24', 'w-14'].map((w, i) => (
                    <div key={i} className={`flex items-center gap-2 px-2 h-7 rounded ${i === 2 ? 'bg-accent' : ''}`}>
                      <div className="h-3 w-3 rounded bg-muted-foreground/15 shrink-0" />
                      <div className={`h-1.5 ${w} rounded-full ${i === 2 ? 'bg-foreground/25' : 'bg-muted-foreground/15'}`} />
                    </div>
                  ))}
                  <div className="h-px bg-border my-1" />
                  <div className="px-2 mb-1">
                    <div className="h-1.5 w-14 rounded-full bg-muted-foreground/10" />
                  </div>
                  {['w-24', 'w-16', 'w-20'].map((w, i) => (
                    <div key={`f-${i}`} className="flex items-center gap-2 px-2 h-7">
                      <div className="h-2 w-2 rounded-full bg-primary/30 shrink-0" />
                      <div className={`h-1.5 ${w} rounded-full bg-muted-foreground/12`} />
                    </div>
                  ))}
                </div>

                {/* Main content — issue list */}
                <div className="flex-1 flex flex-col min-w-0">
                  <div className="flex items-center gap-3 px-4 h-10 border-b border-border">
                    <div className="h-2 w-10 rounded-full bg-muted-foreground/15" />
                    <div className="h-2 w-8 rounded-full bg-muted-foreground/10" />
                    <div className="h-2 w-12 rounded-full bg-muted-foreground/10" />
                    <div className="ml-auto flex gap-2">
                      <div className="h-5 w-5 rounded bg-muted-foreground/8" />
                      <div className="h-5 w-5 rounded bg-muted-foreground/8" />
                    </div>
                  </div>
                  <div className="flex-1">
                    {[
                      { priority: 'bg-destructive', id: 'TRG-142', title: 'w-[180px]', status: 'bg-warning' },
                      { priority: 'bg-destructive', id: 'TRG-139', title: 'w-[220px]', status: 'bg-destructive' },
                      { priority: 'bg-warning', id: 'TRG-138', title: 'w-[160px]', status: 'bg-primary' },
                      { priority: 'bg-primary', id: 'TRG-135', title: 'w-[200px]', status: 'bg-success' },
                      { priority: 'bg-muted-foreground/30', id: 'TRG-131', title: 'w-[140px]', status: 'bg-primary' },
                      { priority: 'bg-warning', id: 'TRG-128', title: 'w-[190px]', status: 'bg-warning' },
                      { priority: 'bg-primary', id: 'TRG-125', title: 'w-[170px]', status: 'bg-success' },
                    ].map((row, i) => (
                      <div key={i} className="relative flex items-center gap-3 px-4 h-9 border-b border-border transition-colors">
                        {i === 1 && (
                          <div className="absolute inset-0" style={{
                            backgroundImage: `repeating-linear-gradient(-45deg, ${diagonalLineColor} / 0.3) 0px, ${diagonalLineColor} / 0.3) 1px, transparent 1px, transparent 6px)`,
                          }} />
                        )}
                        <div className="h-3.5 w-3.5 rounded border border-border flex items-center justify-center shrink-0">
                          <div className={`h-1.5 w-1.5 rounded-sm ${row.priority}`} />
                        </div>
                        <span className="text-[11px] text-muted-foreground font-mono shrink-0">{row.id}</span>
                        <div className={`h-1.5 ${row.title} rounded-full bg-foreground/15`} />
                        <div className="ml-auto flex items-center gap-2">
                          <div className={`h-2 w-2 rounded-full ${row.status}`} />
                          <div className="h-5 w-5 rounded-full bg-muted-foreground/10" />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Detail panel */}
                <div className="w-[280px] border-l border-border shrink-0 hidden lg:flex flex-col">
                  <div className="flex items-center justify-between px-4 h-10 border-b border-border">
                    <div className="h-2 w-20 rounded-full bg-foreground/15" />
                    <div className="flex gap-1.5">
                      <div className="h-4 w-4 rounded bg-muted-foreground/10" />
                      <div className="h-4 w-4 rounded bg-muted-foreground/10" />
                    </div>
                  </div>
                  <div className="p-4 space-y-4">
                    <div className="h-2 w-32 rounded-full bg-foreground/20" />
                    <div className="space-y-1.5">
                      <div className="h-1.5 w-full rounded-full bg-muted-foreground/10" />
                      <div className="h-1.5 w-3/4 rounded-full bg-muted-foreground/10" />
                    </div>
                    <div className="h-px bg-border" />
                    {[
                      { label: 'Status', value: 'bg-warning' },
                      { label: 'Priority', value: 'bg-destructive' },
                      { label: 'Assignee', value: 'bg-primary' },
                      { label: 'Due', value: 'bg-muted-foreground/15' },
                    ].map((prop) => (
                      <div key={prop.label} className="flex items-center justify-between">
                        <span className="text-[11px] text-muted-foreground">{prop.label}</span>
                        <div className={`h-2.5 w-2.5 rounded-full ${prop.value}`} />
                      </div>
                    ))}
                    <div className="h-px bg-border" />
                    <div className="space-y-3 pt-1">
                      <div className="h-1.5 w-14 rounded-full bg-muted-foreground/10" />
                      {[1, 2].map((n) => (
                        <div key={n} className="flex gap-2">
                          <div className="h-5 w-5 rounded-full bg-muted-foreground/10 shrink-0 mt-0.5" />
                          <div className="space-y-1 flex-1">
                            <div className="h-1.5 w-full rounded-full bg-muted-foreground/8" />
                            <div className="h-1.5 w-2/3 rounded-full bg-muted-foreground/8" />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
              <div className="absolute bottom-0 left-0 right-0 h-32 bg-gradient-to-t from-background to-transparent pointer-events-none" />
            </div>
          </div>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* Integrations marquee — ambient background on desktop; on mobile the
          logos come OUT from behind the glass card into crisp foreground rows
          (behind a backdrop-blur they smear into unreadable blobs). */}
      <section className="relative z-10 md:min-h-[520px] py-20 md:py-32 overflow-hidden bg-[hsl(160_35%_8%)] text-white flex items-center">
        <style>{`
          @keyframes marquee-l { from { transform: translateX(0); } to { transform: translateX(-50%); } }
          @keyframes marquee-r { from { transform: translateX(-50%); } to { transform: translateX(0); } }
          .marquee-track { display: flex; width: max-content; gap: 3.5rem; align-items: center; }
          .marquee-l { animation: marquee-l 180s linear infinite; }
          .marquee-r { animation: marquee-r 180s linear infinite; }
          .marquee-chip-track { display: flex; width: max-content; gap: 0.75rem; align-items: center; }
          .marquee-chip-l { animation: marquee-l 55s linear infinite; }
          .marquee-chip-r { animation: marquee-r 70s linear infinite; }
          @media (prefers-reduced-motion: reduce) {
            .marquee-l, .marquee-r, .marquee-chip-l, .marquee-chip-r { animation: none; }
          }
        `}</style>

        {/* Background logo rows (desktop only) */}
        <div
          className="absolute inset-0 hidden md:flex flex-col justify-center gap-16 opacity-[0.55]"
          style={{
            maskImage: 'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
            WebkitMaskImage: 'linear-gradient(to right, transparent, black 10%, black 90%, transparent)',
          }}
        >
          {[
            { rowClass: 'marquee-l', slice: INTEGRATION_LOGOS },
            { rowClass: 'marquee-r', slice: [...INTEGRATION_LOGOS].reverse() },
          ].map((row, ri) => (
            <div key={ri} className="overflow-hidden">
              <div className={`marquee-track ${row.rowClass}`}>
                {[...row.slice, ...row.slice].map((logo, i) => (
                  <img
                    key={`${ri}-${i}`}
                    src={logo.src}
                    alt={logo.name}
                    title={logo.name}
                    loading="lazy"
                    className="h-20 w-20 shrink-0"
                    style={{ filter: 'drop-shadow(0 6px 24px rgba(0,0,0,0.45))' }}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="relative mx-auto w-full max-w-[560px] md:px-6 text-center">
          {/* Copy card — glass treatment only matters on desktop where logos pass behind it */}
          <div className="px-6 md:px-0">
            <div className="inline-block rounded-2xl md:border md:border-white/10 md:bg-[hsl(160_35%_8%)]/85 md:backdrop-blur-md px-2 py-2 md:px-10 md:py-10 md:shadow-2xl">
              <p className="text-[13px] uppercase tracking-[0.15em] text-white/50 mb-4">
                Connections
              </p>
              <h2 className="text-[clamp(1.8rem,3vw,2.5rem)] font-[500] tracking-[-0.03em] leading-[1.15]">
                All your tools in <span className="text-primary">one place.</span>
              </h2>
              <p className="mt-4 text-[15px] text-white/60">
                One connected knowledge layer across the systems your team already trusts.
              </p>
            </div>
          </div>

          {/* Mobile logo rows — full opacity, white chips so every brand mark
              (including near-black ones) stays legible on the dark green */}
          <div
            className="mt-10 space-y-3 md:hidden"
            style={{
              maskImage: 'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
              WebkitMaskImage: 'linear-gradient(to right, transparent, black 8%, black 92%, transparent)',
            }}
          >
            {[
              { rowClass: 'marquee-chip-l', slice: INTEGRATION_LOGOS },
              { rowClass: 'marquee-chip-r', slice: [...INTEGRATION_LOGOS].reverse() },
            ].map((row, ri) => (
              <div key={ri} className="overflow-hidden">
                <div className={`marquee-chip-track ${row.rowClass}`}>
                  {[...row.slice, ...row.slice].map((logo, i) => (
                    <span
                      key={`m-${ri}-${i}`}
                      className="flex h-14 w-14 shrink-0 items-center justify-center rounded-xl bg-white/95 p-2.5 shadow-[0_4px_16px_rgba(0,0,0,0.35)]"
                    >
                      <img src={logo.src} alt={logo.name} title={logo.name} loading="lazy" className="h-full w-full object-contain" />
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* Features */}
      <section className="relative z-10 pt-24 pb-24 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] relative">
          <p className="text-[13px] uppercase tracking-[0.15em] text-muted-foreground mb-4">
            What you get
          </p>
          <h2 className="text-[clamp(1.8rem,3vw,2.5rem)] font-[500] tracking-[-0.03em] text-foreground max-w-[500px] leading-[1.15]">
            Builds immediately.<br />Delivers from day one.
          </h2>

          <div className="mt-16 border border-border">
            <div className="grid grid-cols-1 md:grid-cols-3">
              {[
                {
                  title: 'Build agents in minutes',
                  desc: 'Describe the outcome in plain language. Sublime creates the agent, its instructions, delivery format, integrations, and schedule.',
                  graphic: 'bars',
                },
                {
                  title: 'Connect the tools you already use',
                  desc: 'Historical backfill and live events build a practical understanding of customers, projects, decisions, bottlenecks, and ownership.',
                  graphic: 'flow',
                },
                {
                  title: 'Read every run',
                  desc: 'Every run shows its evidence, tool calls, decisions, errors, and finished artifact, so teams can trust the work and improve it.',
                  graphic: 'chart',
                },
              ].map((feature, i) => (
                <div
                  key={feature.title}
                  className={`p-8 ${i < 2 ? 'md:border-r border-border' : ''} ${i > 0 ? 'border-t md:border-t-0 border-border' : ''}`}
                >
                  <div className="mb-6 h-32 rounded-lg border border-border bg-card/30 flex items-center justify-center">
                    <div className="space-y-2 w-full px-6">
                      {feature.graphic === 'bars' && (
                        <>
                          {[
                            { w: 'w-full', color: 'bg-destructive' },
                            { w: 'w-3/4', color: 'bg-warning' },
                            { w: 'w-1/2', color: 'bg-primary' },
                            { w: 'w-1/4', color: 'bg-success' },
                          ].map((bar, j) => (
                            <div key={j} className="flex items-center gap-2">
                              <div className={`h-2 ${bar.w} rounded-full ${bar.color}`} />
                            </div>
                          ))}
                        </>
                      )}
                      {feature.graphic === 'flow' && (
                        <div className="flex items-center justify-around px-2">
                          {['Slack', 'Notion', 'Linear'].map((n) => INTEGRATION_LOGOS.find((l) => l.name === n)!).map((logo, j) => (
                            <div key={j} className="flex flex-col items-center gap-2">
                              <div className="h-10 w-10 rounded-full bg-white/5 border border-border flex items-center justify-center">
                                <img src={logo.src} alt={logo.name} title={logo.name} className="h-6 w-6 object-contain" />
                              </div>
                              <div className="h-1 w-8 rounded-full bg-muted-foreground/10" />
                            </div>
                          ))}
                        </div>
                      )}
                      {feature.graphic === 'chart' && (
                        <div className="flex items-end gap-1.5 h-16 px-2">
                          {[40, 65, 45, 80, 55, 70, 90].map((h, j) => (
                            <div key={j} className="relative flex-1 rounded-t border border-border overflow-hidden" style={{ height: `${h}%` }}>
                              <div className="absolute inset-0" style={{
                                backgroundImage: `repeating-linear-gradient(-45deg, ${diagonalLineColor} / 0.5) 0px, ${diagonalLineColor} / 0.5) 1px, transparent 1px, transparent 5px)`,
                              }} />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  <h3 className="text-[15px] font-medium text-foreground mb-2">{feature.title}</h3>
                  <p className="text-[13px] leading-[1.6] text-muted-foreground">{feature.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* Product 3D showcase */}
      <section className="relative z-10 py-28 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] relative">
          <div className="text-center max-w-[640px] mx-auto">
            <p className="text-[13px] uppercase tracking-[0.15em] text-muted-foreground mb-4">
              See it in action
            </p>
            <h2 className="text-[clamp(1.8rem,3vw,2.5rem)] font-[500] tracking-[-0.03em] text-foreground leading-[1.15]">
              Not another chatbot.<br />A system that <span className="italic">does the work.</span>
            </h2>
            <p className="mt-5 text-[15px] text-muted-foreground max-w-[480px] mx-auto">
              Build agents, connect your stack, and orchestrate flows. Every run shows its evidence and finished artifact.
            </p>
          </div>

          <InteractiveShowcase
            shots={[
              { src: flowsShot, alt: 'Two teammates collaborating on a Sublime flow canvas', label: 'Collaborative Flows' },
              { src: agentsShot, alt: 'Sublime agents workspace', label: 'Agents' },
              { src: integrationsShot, alt: 'Sublime integrations catalog', label: 'Integrations' },
            ]}
          />

          {/* Mobile: swipeable snap carousel. Near-full-width cards (the next
              one peeks in as the swipe affordance), the desktop active-state
              glow, and a zoomed 4:3 crop so the product UI is actually
              readable at phone size instead of a shrunken desktop screenshot. */}
          <div className="md:hidden mt-12 -mx-6">
            <div className="flex snap-x snap-mandatory gap-4 overflow-x-auto px-6 pb-4 [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {[
                { src: flowsShot, alt: 'Two teammates collaborating on a Sublime flow canvas', label: 'Collaborative Flows' },
                { src: agentsShot, alt: 'Sublime agents workspace', label: 'Agents' },
                { src: integrationsShot, alt: 'Sublime integrations catalog', label: 'Integrations' },
              ].map((shot) => (
                <div
                  key={shot.label}
                  className="relative w-[85%] shrink-0 snap-center overflow-hidden rounded-xl border border-border bg-card"
                  style={{ boxShadow: '0 40px 80px -24px rgba(0,0,0,0.6), 0 0 0 1px hsl(var(--primary) / 0.4)' }}
                >
                  <div className="flex h-8 items-center gap-1.5 border-b border-border bg-muted/40 px-3">
                    <div className="h-2.5 w-2.5 rounded-full bg-destructive/60" />
                    <div className="h-2.5 w-2.5 rounded-full bg-warning/60" />
                    <div className="h-2.5 w-2.5 rounded-full bg-success/60" />
                    <span className="ml-3 text-[11px] font-medium uppercase tracking-[0.12em] text-foreground/70">{shot.label}</span>
                  </div>
                  <img src={shot.src} alt={shot.alt} className="block aspect-[4/3] w-full object-cover object-center" loading="lazy" />
                  {shot.label === 'Collaborative Flows' && <CollaborationCursors />}
                </div>
              ))}
            </div>
            <p className="mt-1 text-center text-[11px] uppercase tracking-[0.15em] text-muted-foreground">
              Swipe to explore
            </p>
          </div>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* Social proof */}
      <section className="relative z-10 py-24 px-6 overflow-hidden">
        {/* Angular line shading background */}
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `repeating-linear-gradient(
              -45deg,
              ${diagonalLineColor} / 0.55) 0px,
              ${diagonalLineColor} / 0.55) 1px,
              transparent 1px,
              transparent 8px
            )`,
            backgroundSize: '100% 100%',
          }}
        />
        <div className="mx-auto max-w-[1200px] relative">
          <div className="border border-border bg-background p-10 max-w-[720px] mx-auto">
            <blockquote className="text-[20px] font-[400] leading-[1.5] tracking-[-0.01em] text-foreground/85">
              &ldquo;Sublime plugged into our stack in an afternoon and shipped a weekly pipeline digest that actually surfaces at-risk deals. It&rsquo;s not another chatbot. It does the work.&rdquo;
            </blockquote>
            <div className="mt-6 flex items-center gap-3">
              <img src={testimonialAvatar} alt="Jamie Kim" className="h-8 w-8 rounded-full object-cover" />
              <div>
                <span className="text-[13px] font-medium text-foreground">Jamie Kim</span>
                <span className="text-[13px] text-muted-foreground ml-2">Head of Revenue Ops, Falken Group</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* Pricing */}
      <section id="pricing" className="relative z-10 pt-24 pb-24 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] relative">
          <p className="text-[13px] uppercase tracking-[0.15em] text-muted-foreground mb-4">
            Pricing
          </p>
          <h2 className="text-[clamp(1.8rem,3vw,2.5rem)] font-[500] tracking-[-0.03em] text-foreground max-w-[500px] leading-[1.15]">
            Plans that scale<br />with your team.
          </h2>

          <div className="mt-16"><PricingGrid /></div>
          <p className="mt-4 text-[12px] text-muted-foreground">
            Subscriptions start when you check out and can be canceled anytime. 1 credit = 1,000 AI
            tokens; credits are shared across your workspace. Checkout and invoicing are handled
            securely by Stripe.
          </p>
        </div>
      </section>

      {/* Full-width divider */}
      <div className="relative z-10 w-full border-t border-border" />

      {/* CTA */}
      <section className="relative z-10 pt-32 pb-40 px-6 overflow-hidden">
        <div className="mx-auto max-w-[1200px] text-center relative">
          <h2 className="text-[clamp(2rem,4vw,3.2rem)] font-[500] tracking-[-0.035em] text-foreground leading-[1.1] mx-auto max-w-[560px]">
            Start using AI that actually works.
          </h2>
          <p className="mt-5 text-[15px] text-muted-foreground max-w-[400px] mx-auto">
            Connect your tools and deploy your first<br />business-ready agent today.
          </p>
          <div className="mt-10 flex justify-center">
            <Link href="/auth/signup">
              <button
                className="group relative inline-flex items-center gap-2.5 px-8 py-3.5 text-[15px] font-medium transition-all duration-200 border border-foreground/40 text-foreground hover:bg-foreground hover:text-background hover:border-foreground"
              >
                Create an account
                <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-1" />
              </button>
            </Link>
          </div>
        </div>
      </section>

      {/* Footer */}
      <div className="relative z-10 border-t border-border">
        <div className="mx-auto max-w-[1200px] px-6 py-6 flex items-center justify-between">
          <div className="flex items-center gap-2 -ml-0.5">
            <StackedLogo size={16} />
            <span className="text-[12px] font-bold text-foreground uppercase tracking-[0.08em]">Sublime</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/about" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              About
            </Link>
            <Link href="/contact" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Contact
            </Link>
            <Link href="/privacy" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="text-[12px] text-muted-foreground hover:text-foreground transition-colors">
              Terms
            </Link>
            <span className="text-[12px] text-muted-foreground">© {new Date().getFullYear()}</span>
          </div>
        </div>
      </div>
    </div>
  )
}
