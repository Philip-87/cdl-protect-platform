'use client'

import Link from 'next/link'
import { usePathname, useSearchParams } from 'next/navigation'
import ThemeToggle from '@/app/components/ThemeToggle'
import { hasPlatformFeature } from '@/app/lib/server/role-features'
import { isAttorneyRole, isStaffRole, roleCanCreateFleet, roleHasFleetWorkspace, type PlatformRole } from '@/app/lib/roles'

type Viewer = {
  role: PlatformRole
  email: string | null
  enabledFeatures?: string[]
  workspaceSignals?: {
    unreadNotifications: number
  } | null
  attorneySignals?: {
    emailSyncConnected: boolean
    emailSyncLabel: string
    calendarSyncConnected: boolean
    calendarSyncLabel: string
    openTasks: number
    pendingOffers: number
    unreadNotifications: number
  } | null
}

type NavItem = {
  key: string
  href: string
  label: string
}

function initialsFromEmail(email: string | null | undefined) {
  const value = String(email ?? '').trim()
  if (!value) return 'CP'
  return value.slice(0, 2).toUpperCase()
}

function getAgencyNav(role: PlatformRole, enabledFeatures: readonly string[]): NavItem[] {
  const items: NavItem[] = [{ key: 'dashboard', href: '/dashboard', label: 'Dashboard' }]

  if (roleHasFleetWorkspace(role) && hasPlatformFeature(enabledFeatures, 'fleet_workspace')) {
    items.push({ key: 'fleets', href: '/my-fleets', label: 'My Fleets' })
  }

  if (hasPlatformFeature(enabledFeatures, 'ticket_intake')) {
    items.push({ key: 'intake', href: '/intake', label: 'Ticket Intake' })
  }
  if (hasPlatformFeature(enabledFeatures, 'cases_workspace')) {
    items.push({ key: 'cases', href: '/dashboard?tab=cases#case-queue', label: 'Cases' })
  }
  if (hasPlatformFeature(enabledFeatures, 'notification_inbox')) {
    items.push({ key: 'notifications', href: '/notifications#notification-inbox', label: 'Notifications' })
  }
  items.push({ key: 'settings', href: '/settings', label: 'Settings' })
  if (roleCanCreateFleet(role) && hasPlatformFeature(enabledFeatures, 'fleet_creation')) {
    items.splice(2, 0, { key: 'create-fleet', href: '/my-fleets#create-fleet', label: 'Create Fleet' })
  }
  if (isStaffRole(role)) {
    items.push({ key: 'admin', href: '/admin/dashboard', label: 'Admin' })
  }
  return items
}

function getAttorneyNav(enabledFeatures: readonly string[]): NavItem[] {
  const items: NavItem[] = [{ key: 'dashboard', href: '/attorney/dashboard', label: 'Dashboard' }]
  if (hasPlatformFeature(enabledFeatures, 'attorney_calendar')) {
    items.push({ key: 'calendar', href: '/attorney/calendar', label: 'Calendar' })
  }
  if (hasPlatformFeature(enabledFeatures, 'cases_workspace')) {
    items.push({ key: 'cases', href: '/attorney/dashboard#case-queue', label: 'Cases' })
  }
  if (hasPlatformFeature(enabledFeatures, 'attorney_communications')) {
    items.push({ key: 'communications', href: '/attorney/communications', label: 'Communications' })
  }
  if (hasPlatformFeature(enabledFeatures, 'attorney_tasks')) {
    items.push({ key: 'tasks', href: '/attorney/tasks', label: 'Tasks' })
  }
  if (hasPlatformFeature(enabledFeatures, 'attorney_reminders')) {
    items.push({ key: 'reminders', href: '/attorney/reminders', label: 'Reminders' })
  }
  items.push({ key: 'firm', href: '/attorney/my-firm', label: 'My Firm' })
  items.push({ key: 'integrations', href: '/attorney/integrations', label: 'Integrations' })
  if (hasPlatformFeature(enabledFeatures, 'attorney_billing')) {
    items.push({ key: 'billing', href: '/attorney/billing', label: 'Billing' })
  }
  items.push({ key: 'settings', href: '/attorney/settings', label: 'Settings' })
  return items
}

function isActiveNavItem(pathname: string, searchTab: string, key: string) {
  if (pathname.startsWith('/admin')) return key === 'admin'
  if (pathname.startsWith('/attorney')) {
    if (pathname === '/attorney/dashboard') return key === 'dashboard'
    if (pathname.startsWith('/attorney/calendar')) return key === 'calendar'
    if (pathname.startsWith('/attorney/communications')) return key === 'communications'
    if (pathname.startsWith('/attorney/tasks')) return key === 'tasks'
    if (pathname.startsWith('/attorney/reminders')) return key === 'reminders'
    if (pathname.startsWith('/attorney/my-firm')) return key === 'firm'
    if (pathname.startsWith('/attorney/integrations')) return key === 'integrations'
    if (pathname.startsWith('/attorney/billing')) return key === 'billing'
    if (pathname.startsWith('/attorney/settings')) return key === 'settings'
    return false
  }
  if (pathname === '/my-fleets') return key === 'fleets'
  if (pathname === '/notifications') return key === 'notifications'
  if (pathname === '/intake') return key === 'intake'
  if (pathname === '/settings') return key === 'settings'
  if (pathname === '/dashboard') {
    if (searchTab === 'cases') return key === 'cases'
    return key === 'dashboard'
  }
  return false
}

export default function AppTopNav({ viewer }: { viewer: Viewer | null }) {
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const role = viewer?.role ?? 'NONE'
  const enabledFeatures = viewer?.enabledFeatures ?? []
  const navItems = !viewer ? [] : isAttorneyRole(role) ? getAttorneyNav(enabledFeatures) : getAgencyNav(role, enabledFeatures)
  const searchTab = String(searchParams.get('tab') ?? '').trim().toLowerCase()
  const settingsHref = isAttorneyRole(role) ? '/attorney/settings#account' : '/settings#account'
  const organizationHref = isAttorneyRole(role) ? '/attorney/my-firm' : '/settings#organization'
  const billingHref = isAttorneyRole(role) ? '/attorney/billing' : '/settings#billing'
  const workspaceSignals = !isAttorneyRole(role) ? viewer?.workspaceSignals ?? null : null
  const attorneySignals = isAttorneyRole(role) ? viewer?.attorneySignals ?? null : null

  return (
    <header className="site-header">
      <div className="container topbar">
        <div className="topbar-brand">
          <Link href={viewer ? (isAttorneyRole(role) ? '/attorney/dashboard' : '/dashboard') : '/'} className="brand">
            CDL Protect
          </Link>
          <p className="topbar-brand-copy">Enterprise ticket and case operations for fleets, drivers, and attorneys.</p>
        </div>

        {viewer ? (
          <nav className="topbar-nav" aria-label="Primary">
            {navItems.map((item) => (
              <Link
                key={item.key}
                href={item.href}
                className={`topbar-link ${isActiveNavItem(pathname, searchTab, item.key) ? 'active' : ''}`}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : (
          <nav className="topbar-nav" aria-label="Primary">
            <Link href="/login" className="topbar-link">
              Sign In
            </Link>
            <Link href="/signup" className="topbar-link active">
              Create Account
            </Link>
          </nav>
        )}

        <div className="topbar-actions">
          {workspaceSignals && hasPlatformFeature(enabledFeatures, 'notification_inbox') ? (
            <div className="topbar-signal-strip" aria-label="Workspace notification status">
              <Link
                href="/notifications#notification-inbox"
                className={`topbar-signal ${workspaceSignals.unreadNotifications ? 'is-alert' : ''}`}
              >
                {workspaceSignals.unreadNotifications} notifications
              </Link>
            </div>
          ) : null}
          {attorneySignals ? (
            <div className="topbar-signal-strip" aria-label="Attorney workspace status">
              <span className={`topbar-signal ${attorneySignals.emailSyncConnected ? 'is-positive' : ''}`}>
                {attorneySignals.emailSyncLabel}
              </span>
              {hasPlatformFeature(enabledFeatures, 'attorney_calendar') ? (
                <span className={`topbar-signal ${attorneySignals.calendarSyncConnected ? 'is-positive' : ''}`}>
                  {attorneySignals.calendarSyncLabel}
                </span>
              ) : null}
              {hasPlatformFeature(enabledFeatures, 'attorney_tasks') ? (
                <Link href="/attorney/tasks" className={`topbar-signal ${attorneySignals.openTasks ? 'is-alert' : ''}`}>
                  {attorneySignals.openTasks} open tasks
                </Link>
              ) : null}
              {hasPlatformFeature(enabledFeatures, 'attorney_reminders') ? (
                <Link
                  href="/attorney/reminders#notification-inbox"
                  className={`topbar-signal ${attorneySignals.unreadNotifications ? 'is-alert' : ''}`}
                >
                  {attorneySignals.unreadNotifications} notifications
                </Link>
              ) : null}
              <Link
                href="/attorney/dashboard?view=pending-acceptance"
                className={`topbar-signal ${attorneySignals.pendingOffers ? 'is-alert' : ''}`}
              >
                {attorneySignals.pendingOffers} pending offers
              </Link>
            </div>
          ) : null}
          <ThemeToggle />
          {viewer ? (
            <details className="user-menu">
              <summary className="user-menu-trigger" aria-label="Open account menu">
                <span className="user-menu-avatar">{initialsFromEmail(viewer.email)}</span>
                <span className="user-menu-meta">
                  <strong>{viewer.email ?? 'Workspace user'}</strong>
                  <span>{role}</span>
                </span>
              </summary>
              <div className="user-menu-panel">
                <Link href={settingsHref} className="user-menu-item">
                  Account
                </Link>
                <Link href={organizationHref} className="user-menu-item">
                  Organization
                </Link>
                <Link href={billingHref} className="user-menu-item">
                  Billing
                </Link>
                <Link href="/logout" className="user-menu-item danger">
                  Sign Out
                </Link>
              </div>
            </details>
          ) : null}
        </div>
      </div>
    </header>
  )
}
