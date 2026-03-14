'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { SignOutForm } from '@/app/components/SignOutForm'

export type AttorneyWorkspaceKey =
  | 'dashboard'
  | 'calendar'
  | 'cases'
  | 'communications'
  | 'tasks'
  | 'reminders'
  | 'coverage'
  | 'my-firm'
  | 'integrations'
  | 'billing'
  | 'settings'
  | 'onboarding'

type SidebarLink = {
  key: AttorneyWorkspaceKey
  href: string
  label: string
  icon: ReactNode
}

function OverviewIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 3h6v6H3V3Zm8 0h6v4h-6V3ZM3 11h4v6H3v-6Zm6-2h8v8H9V9Z" fill="currentColor" />
    </svg>
  )
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M6 2.5a.75.75 0 0 1 .75.75V4h6.5v-.75a.75.75 0 0 1 1.5 0V4H16a2 2 0 0 1 2 2v9.5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h1.25v-.75A.75.75 0 0 1 6 2.5ZM3.5 8v7.5a.5.5 0 0 0 .5.5h12a.5.5 0 0 0 .5-.5V8h-13Zm3 2h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 3h2v2h-2v-2Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CasesIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4.5 3A1.5 1.5 0 0 0 3 4.5v11A1.5 1.5 0 0 0 4.5 17h11a1.5 1.5 0 0 0 1.5-1.5v-11A1.5 1.5 0 0 0 15.5 3h-11Zm1 3h9V7.5h-9V6Zm0 3h9v1.5h-9V9Zm0 3h6v1.5h-6V12Z" fill="currentColor" />
    </svg>
  )
}

function InboxIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11Zm1.7.3L10 9.24l5.3-4.44H4.7ZM16 6.1l-4.7 3.94a2 2 0 0 1-2.6 0L4 6.1v9.4h12V6.1Z"
        fill="currentColor"
      />
    </svg>
  )
}

function TaskIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M14.5 3a2.5 2.5 0 0 1 2.45 3H18v11H2V6h1.05A2.5 2.5 0 0 1 5.5 3h9Zm0 1.5h-9a1 1 0 0 0 0 2h9a1 1 0 0 0 0-2ZM4 8v7h12V8H4Zm2 1.5h5V11H6V9.5Zm0 3h7V14H6v-1.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

function ReminderIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.5A4.5 4.5 0 0 0 5.5 7v2.15c0 .74-.2 1.47-.57 2.11L3.7 13.4A1 1 0 0 0 4.56 15h10.88a1 1 0 0 0 .86-1.6l-1.23-2.14a4.2 4.2 0 0 1-.57-2.11V7A4.5 4.5 0 0 0 10 2.5Zm0 15a2.23 2.23 0 0 1-2.1-1.5h4.2A2.23 2.23 0 0 1 10 17.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

function CoverageIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2 3.5 4.2v5.06c0 4.1 2.67 7.83 6.5 8.94 3.83-1.11 6.5-4.84 6.5-8.94V4.2L10 2Zm0 2.1 4.5 1.52v3.64c0 3.06-1.83 5.9-4.5 6.95-2.67-1.05-4.5-3.89-4.5-6.95V5.62L10 4.1Zm-.88 2.57H7.64v2.24H5.4v1.48h2.24v2.24h1.48v-2.24h2.24V8.91H9.12V6.67Z"
        fill="currentColor"
      />
    </svg>
  )
}

function FirmIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M4 3h8a1 1 0 0 1 1 1v2h3a1 1 0 0 1 1 1v10H3V4a1 1 0 0 1 1-1Zm1 2v10h2V5H5Zm3 0v10h4V5H8Zm6 3v7h2V8h-2Zm-5 1h2v2H9V9Zm0 3h2v2H9v-2Z"
        fill="currentColor"
      />
    </svg>
  )
}

function IntegrationIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M7.5 3A3.5 3.5 0 0 1 11 6.5v1H9.5v-1a2 2 0 1 0-4 0v2a2 2 0 1 0 4 0v-.5H11v.5A3.5 3.5 0 1 1 4 8.5v-2A3.5 3.5 0 0 1 7.5 3Zm5 6A3.5 3.5 0 0 1 16 12.5v2A3.5 3.5 0 0 1 9 14.5v-1h1.5v1a2 2 0 1 0 4 0v-2a2 2 0 1 0-4 0v.5H9v-.5A3.5 3.5 0 0 1 12.5 9ZM7 9.25h6v1.5H7v-1.5Z"
        fill="currentColor"
      />
    </svg>
  )
}

function BillingIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M3 4.5A1.5 1.5 0 0 1 4.5 3h11A1.5 1.5 0 0 1 17 4.5v11a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 15.5v-11Zm1.5 0v2h11v-2h-11Zm0 4v7h11v-7h-11Zm2 1.5h3.25v1.5H6.5V10Zm0 3h5.5v1.5H6.5V13Z"
        fill="currentColor"
      />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M11 2.3a1 1 0 0 0-2 0l-.17 1.4a6.66 6.66 0 0 0-1.7.7L5.96 3.6a1 1 0 1 0-1.42 1.41l.8 1.17a6.7 6.7 0 0 0-.7 1.7l-1.4.17a1 1 0 0 0 0 2l1.4.17c.14.6.38 1.17.7 1.7l-.8 1.17a1 1 0 1 0 1.42 1.41l1.17-.8c.53.32 1.1.56 1.7.7l.17 1.4a1 1 0 0 0 2 0l.17-1.4c.6-.14 1.17-.38 1.7-.7l1.17.8a1 1 0 1 0 1.41-1.41l-.8-1.17c.32-.53.56-1.1.7-1.7l1.4-.17a1 1 0 0 0 0-2l-1.4-.17a6.68 6.68 0 0 0-.7-1.7l.8-1.17A1 1 0 1 0 14.04 3.6l-1.17.8a6.66 6.66 0 0 0-1.7-.7L11 2.3ZM10 7a3 3 0 1 1 0 6 3 3 0 0 1 0-6Z" fill="currentColor" />
    </svg>
  )
}

function SignOutIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-5v-2h5V5h-5V3ZM8.7 5.3l1.4 1.4-1.8 1.8H14v2H8.3l1.8 1.8-1.4 1.4L4.5 10l4.2-4.7Z" fill="currentColor" />
    </svg>
  )
}

function SidebarLinkItem({
  item,
  active,
  onNavigate,
}: {
  item: SidebarLink
  active: boolean
  onNavigate?: () => void
}) {
  return (
    <Link href={item.href} className={`workspace-nav-link ${active ? 'active' : ''}`} onClick={onNavigate}>
      <span className="workspace-nav-icon">{item.icon}</span>
      <span>{item.label}</span>
    </Link>
  )
}

function AttorneySidebarPanel({
  active,
  onNavigate,
}: {
  active: AttorneyWorkspaceKey
  onNavigate?: () => void
}) {
  const workdayLinks: SidebarLink[] = [
    { key: 'dashboard', href: '/attorney/dashboard', label: 'Dashboard', icon: <OverviewIcon /> },
    { key: 'calendar', href: '/attorney/calendar', label: 'Calendar', icon: <CalendarIcon /> },
    { key: 'cases', href: '/attorney/dashboard#case-queue', label: 'Cases', icon: <CasesIcon /> },
    { key: 'communications', href: '/attorney/communications', label: 'Communications', icon: <InboxIcon /> },
  ]

  const docketingLinks: SidebarLink[] = [
    { key: 'tasks', href: '/attorney/tasks', label: 'Tasks', icon: <TaskIcon /> },
    { key: 'reminders', href: '/attorney/reminders', label: 'Reminders', icon: <ReminderIcon /> },
  ]

  const practiceLinks: SidebarLink[] = [
    { key: 'coverage', href: '/attorney/coverage-fees', label: 'Coverage & Fees', icon: <CoverageIcon /> },
    { key: 'my-firm', href: '/attorney/my-firm', label: 'My Firm / Profile', icon: <FirmIcon /> },
    { key: 'integrations', href: '/attorney/integrations', label: 'Integrations', icon: <IntegrationIcon /> },
    { key: 'onboarding', href: '/attorney/onboarding', label: 'Onboarding', icon: <FirmIcon /> },
  ]

  const adminLinks: SidebarLink[] = [
    { key: 'billing', href: '/attorney/billing', label: 'Billing', icon: <BillingIcon /> },
    { key: 'settings', href: '/attorney/settings', label: 'Settings', icon: <SettingsIcon /> },
  ]

  return (
    <>
      <div className="workspace-sidebar-header">
        <p className="workspace-sidebar-eyebrow">Attorney Workspace</p>
        <p className="workspace-sidebar-title">Legal operations cockpit</p>
        <p className="workspace-sidebar-copy">
          Keep matters, hearings, reminders, communications, and routing readiness in one professional workspace.
        </p>
      </div>

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Workday</p>
        <div className="workspace-sidebar-links">
          {workdayLinks.map((item) => (
            <SidebarLinkItem key={item.key} item={item} active={item.key === active} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Docketing</p>
        <div className="workspace-sidebar-links">
          {docketingLinks.map((item) => (
            <SidebarLinkItem key={item.key} item={item} active={item.key === active} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Practice Setup</p>
        <div className="workspace-sidebar-links">
          {practiceLinks.map((item) => (
            <SidebarLinkItem key={item.key} item={item} active={item.key === active} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Business Operations</p>
        <div className="workspace-sidebar-links">
          {adminLinks.map((item) => (
            <SidebarLinkItem key={item.key} item={item} active={item.key === active} onNavigate={onNavigate} />
          ))}
          <SignOutForm className="workspace-nav-link" onClick={onNavigate}>
            <span className="workspace-nav-icon">
              <SignOutIcon />
            </span>
            <span>Sign Out</span>
          </SignOutForm>
        </div>
      </div>

      <div className="attorney-sidebar-quick-grid">
        <Link href="/attorney/dashboard#today-desk" className="button-link secondary workspace-sidebar-cta" onClick={onNavigate}>
          Today Desk
        </Link>
        <Link href="/attorney/calendar" className="button-link secondary workspace-sidebar-cta" onClick={onNavigate}>
          Open Calendar
        </Link>
        <Link href="/attorney/reminders#new-reminder" className="button-link secondary workspace-sidebar-cta" onClick={onNavigate}>
          New Reminder
        </Link>
      </div>
    </>
  )
}

export function AttorneyWorkspaceLayout({
  active,
  title,
  description,
  actions,
  subnav,
  statusRail,
  children,
}: {
  active: AttorneyWorkspaceKey
  title: string
  description: string
  actions?: ReactNode
  subnav?: ReactNode
  statusRail?: ReactNode
  children: ReactNode
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="workspace-shell attorney-shell">
      <div className="workspace-mobile-controls">
        <button
          type="button"
          className="button-link secondary workspace-drawer-toggle"
          aria-expanded={drawerOpen}
          aria-controls="attorney-mobile-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          Attorney Menu
        </button>
        {actions ? <div className="workspace-compact-actions card">{actions}</div> : null}
      </div>

      <div className={`workspace-mobile-drawer ${drawerOpen ? 'open' : ''}`} id="attorney-mobile-drawer">
        <button
          type="button"
          className="workspace-drawer-scrim"
          aria-label="Close attorney navigation"
          onClick={() => setDrawerOpen(false)}
        />
        <div className="workspace-mobile-drawer-card card" role="dialog" aria-modal="true" aria-label="Attorney navigation">
          <div className="workspace-mobile-drawer-header">
            <div>
              <p className="workspace-sidebar-eyebrow">Attorney Navigation</p>
              <p className="workspace-sidebar-title">Matter workspace</p>
            </div>
            <button type="button" className="button-link ghost workspace-drawer-close" onClick={() => setDrawerOpen(false)}>
              Close
            </button>
          </div>
          <div className="workspace-mobile-drawer-body">
            <AttorneySidebarPanel active={active} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      </div>

      <div className="workspace-layout">
        <aside className="workspace-sidebar card" aria-label="Attorney workspace navigation">
          <AttorneySidebarPanel active={active} />
        </aside>

        <section className="workspace-content attorney-page-stack">
          <header className="page-header attorney-page-header">
            <div className="page-header-copy">
              <p className="page-eyebrow">Attorney Operations</p>
              <h1 className="page-title">{title}</h1>
              <p className="page-description">{description}</p>
              {subnav ? <div className="workspace-subnav attorney-subnav">{subnav}</div> : null}
            </div>
            {actions ? <div className="page-header-actions">{actions}</div> : null}
          </header>
          {statusRail ? <div className="attorney-status-rail">{statusRail}</div> : null}
          {children}
        </section>
      </div>
    </div>
  )
}
