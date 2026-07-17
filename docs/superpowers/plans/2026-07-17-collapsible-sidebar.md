# Collapsible Sidebar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop sidebar collapsible to a ~64px icon rail, persisted per browser, with a toggle button and ⌘B/Ctrl+B shortcut. Mobile drawer unchanged.

**Architecture:** A `collapsed` boolean inside the `Sidebar` component, initialized from `localStorage('sidebar.collapsed')` and written back on toggle (same idiom as `dashboard.assistantWidth`). A derived `rail = collapsed && !mobileOpen` drives conditional rendering so the mobile overlay always renders expanded. No app-shell or context changes — the sidebar is a flex child, so the width swap reflows content automatically.

**Tech Stack:** React 18 client component, Tailwind classes, lucide-react icons.

**Spec:** `docs/superpowers/specs/2026-07-17-collapsible-sidebar-design.md`

## Global Constraints

- Collapse applies at desktop only; the mobile overlay drawer always renders expanded (`rail = collapsed && !mobileOpen` and the toggle button is `hidden lg:inline-flex`).
- `localStorage` key: `sidebar.collapsed`, value `'1'` when collapsed, removed when expanded; all reads/writes `try/catch` guarded.
- Keyboard shortcut: `⌘B` / `Ctrl+B`, registered in the existing `keydown` effect that handles `⌘K`.
- Rail keeps: org logo (click expands), expand toggle, search icon, bell, 4 nav icons with `title` tooltips + active pill, user avatar → `/settings`. Rail hides: org name/chevron, search label/kbd, agent tree, section headers, usage meter, user text/plan badge.
- No component-test infra exists — verification is `npm run typecheck` + `npm run lint` (+ manual dev pass where an env is available).

---

### Task 1: Collapsible sidebar rail

**Files:**
- Modify: `src/components/layout/sidebar.tsx`

**Interfaces:**
- Consumes: existing `Sidebar` internals — `mobileOpen`, `setPaletteOpen`, `activeOrg`, `usage`, `sections`, `navigation`, `NotificationBell`, `Button`, `cn`.
- Produces: no new exports; purely internal state (`collapsed`, `toggleCollapsed`, derived `rail`).

- [ ] **Step 1: Add icons, storage key, state, and toggle**

In the lucide import block add `PanelLeft` and `PanelLeftClose` (alphabetical placement):

```ts
import {
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  ImagePlus,
  Loader2,
  Lock,
  LogOut,
  PanelLeft,
  PanelLeftClose,
  Play,
  Plug,
  Plus,
  Search,
  Sparkles,
  Trash2,
  Workflow,
} from 'lucide-react'
```

Below the `CREDIT_TOKENS` constant add:

```ts
// Desktop sidebar collapse (icon rail) — persisted per browser.
const COLLAPSED_KEY = 'sidebar.collapsed'
```

Inside `Sidebar()`, after the `const [mobileOpen, setMobileOpen] = useState(false)` line, add:

```ts
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    try {
      return window.localStorage.getItem(COLLAPSED_KEY) === '1'
    } catch {
      return false
    }
  })
  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      const next = !current
      try {
        if (next) window.localStorage.setItem(COLLAPSED_KEY, '1')
        else window.localStorage.removeItem(COLLAPSED_KEY)
      } catch {
        /* storage unavailable — session-only toggle */
      }
      return next
    })
  }, [])
```

- [ ] **Step 2: Register ⌘B in the existing keydown effect**

The effect currently reads:

```ts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])
```

Replace with:

```ts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setPaletteOpen((open) => !open)
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b') {
        event.preventDefault()
        toggleCollapsed()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [toggleCollapsed])
```

- [ ] **Step 3: Derive `rail` and switch the container width**

After the `const activeOrg = ...` line add:

```ts
  // The rail applies on desktop only: the mobile drawer (mobileOpen) always
  // renders expanded, and when closed it is off-canvas anyway.
  const rail = collapsed && !mobileOpen
```

The container div currently reads:

```tsx
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex w-72 flex-col border-r border-white/10 bg-gradient-sublime text-white shadow-[12px_0_40px_rgba(6,47,51,0.08)] transition-transform duration-200 lg:relative lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
```

Replace with:

```tsx
      <div
        className={cn(
          'fixed inset-y-0 left-0 z-50 flex flex-col border-r border-white/10 bg-gradient-sublime text-white shadow-[12px_0_40px_rgba(6,47,51,0.08)] transition-[width,transform] duration-200 lg:relative lg:translate-x-0',
          rail ? 'w-16' : 'w-72',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
      >
```

- [ ] **Step 4: Rail variant of the header (org switcher + search row)**

The header section is the `{/* Org switcher */}` div. Wrap its contents in a rail conditional. The existing block starts:

```tsx
        {/* Org switcher */}
        <div className="relative border-b border-white/10 p-3">
          <button
            className="flex w-full items-center gap-2 rounded-xl px-2 py-1.5 transition-colors duration-fast hover:bg-white/10"
            onClick={() => setOrgMenuOpen((open) => !open)}
```

Change the section to render a rail column when `rail` is true, otherwise the existing content unchanged:

```tsx
        {/* Org switcher */}
        <div className={cn('relative border-b border-white/10', rail ? 'p-2' : 'p-3')}>
          {rail ? (
            <div className="flex flex-col items-center gap-2">
              {/* The org dropdown can't fit in the rail — the logo expands instead. */}
              <button
                onClick={toggleCollapsed}
                aria-label="Expand sidebar"
                title={`${activeOrg?.name || 'Workspace'} — expand sidebar`}
                className="rounded-xl p-0.5 transition-colors duration-fast hover:bg-white/10"
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={activeOrg?.logoUrl || DEFAULT_ORG_LOGO}
                  alt=""
                  className="h-8 w-8 rounded-lg bg-white object-cover p-0.5 shadow-2 ring-1 ring-white/20"
                />
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Expand sidebar"
                title="Expand sidebar (⌘B)"
                className="h-8 w-8 text-[#B9D3D2] hover:bg-white/10 hover:text-white"
                onClick={toggleCollapsed}
              >
                <PanelLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Search"
                title="Search (⌘K)"
                className="h-8 w-8 text-[#B9D3D2] hover:bg-white/10 hover:text-white"
                onClick={() => setPaletteOpen(true)}
              >
                <Search className="h-4 w-4" />
              </Button>
              <NotificationBell buttonClassName="border-white/15 bg-white/10 text-white hover:border-white/30 hover:bg-white/15 hover:text-white" />
            </div>
          ) : (
            <>
              {/* ...the ENTIRE existing header content, unchanged: org button,
                  orgMenuOpen dropdown, and the search row... */}
            </>
          )}
        </div>
```

(Keep every existing line of the expanded content inside the `<>...</>` — only its indentation changes.)

Then, in the expanded search row (`<div className="mt-2 flex items-center gap-2">`), add the collapse toggle after `<NotificationBell ... />`:

```tsx
            <Button
              variant="ghost"
              size="icon"
              aria-label="Collapse sidebar"
              title="Collapse sidebar (⌘B)"
              className="hidden h-8 w-8 shrink-0 text-[#B9D3D2] hover:bg-white/10 hover:text-white lg:inline-flex"
              onClick={toggleCollapsed}
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
```

- [ ] **Step 5: Icon-only nav in rail mode**

The nav block currently reads:

```tsx
          <nav className="mb-2 space-y-0.5">
            {navigation.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm font-medium transition-colors duration-fast',
                    isActive ? 'bg-[#FFF0E8] text-[#062F33] shadow-2' : 'text-[#C0D5D5] hover:bg-white/10 hover:text-white',
                  )}
                >
                  <item.icon className={cn('h-4 w-4', isActive ? 'text-[#E95725]' : 'text-[#7DACA8]')} />
                  {item.name}
                </Link>
              )
            })}
          </nav>
```

Replace with:

```tsx
          <nav className="mb-2 space-y-0.5">
            {navigation.map((item) => {
              const isActive = pathname === item.href || (item.href !== '/dashboard' && pathname.startsWith(item.href))
              return (
                <Link
                  key={item.name}
                  href={item.href}
                  aria-label={item.name}
                  title={rail ? item.name : undefined}
                  className={cn(
                    'flex items-center gap-2.5 rounded-lg text-sm font-medium transition-colors duration-fast',
                    rail ? 'justify-center p-2' : 'px-2 py-1.5',
                    isActive ? 'bg-[#FFF0E8] text-[#062F33] shadow-2' : 'text-[#C0D5D5] hover:bg-white/10 hover:text-white',
                  )}
                >
                  <item.icon className={cn('h-4 w-4 shrink-0', isActive ? 'text-[#E95725]' : 'text-[#7DACA8]')} />
                  {!rail && item.name}
                </Link>
              )
            })}
          </nav>
```

- [ ] **Step 6: Hide the agent tree and usage; avatar-only footer in rail mode**

Wrap BOTH agent-tree sections — the Workspace drop-zone div (`{...dropProps('workspace', ...)}` through its closing `</div>`) and the Private drop-zone div (`{...dropProps('private', ...)}` through its closing `</div>`) — in a single conditional:

```tsx
          {!rail && (
            <>
              {/* ...existing Workspace section div, unchanged... */}
              {/* ...existing Private section div, unchanged... */}
            </>
          )}
```

In the footer (`{/* Footer: usage + user */}`):

1. Change the usage condition from `{usage && (` to `{!rail && usage && (`.
2. Change the footer wrapper class to `cn('border-t border-white/10', rail ? 'p-2' : 'p-3')`.
3. On the settings `Link`, add a rail tooltip and center it:

```tsx
          <Link
            href="/settings"
            aria-label="Open settings"
            title={rail ? 'Settings' : undefined}
            className={cn(
              'flex items-center gap-2 rounded-xl px-1 py-1 transition-colors hover:bg-white/10',
              rail && 'justify-center px-0',
              pathname.startsWith('/settings') && 'bg-white/10',
            )}
          >
```

4. Wrap the name/email block and the plan badge in `{!rail && ...}`:

```tsx
            {!rail && (
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{user?.firstName || 'Account'}</div>
                <div className="truncate text-xs text-[#7DACA8]">{user?.emailAddress}</div>
              </div>
            )}
            {!rail && activeOrg && (
              <span className="rounded-full bg-white/10 px-2 py-0.5 text-xs text-[#B9D3D2]">{planLabel(activeOrg.plan)}</span>
            )}
```

- [ ] **Step 7: Verify**

Run: `npm run typecheck > /dev/null 2>&1; echo $?` — expected `0`.
Run: `npm run lint` — expected no errors.
If a configured env is available: `npm run dev`, then confirm — toggle collapses to the rail, ⌘B toggles, state survives reload, org-logo click expands, nav tooltips show, mobile drawer still renders the full sidebar.

- [ ] **Step 8: Commit**

```bash
git add src/components/layout/sidebar.tsx
git commit -m "feat: make the desktop sidebar collapsible to an icon rail

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```
