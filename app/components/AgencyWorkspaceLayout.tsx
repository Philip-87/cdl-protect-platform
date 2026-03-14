'use client'

import type { ReactNode } from 'react'
import { useState } from 'react'
import Link from 'next/link'
import { SignOutForm } from '@/app/components/SignOutForm'
import { hasPlatformFeature } from '@/app/lib/server/role-features'
import { isStaffRole, roleCanCreateFleet, roleCanInvite, roleHasFleetWorkspace, type PlatformRole } from '@/app/lib/roles'

type AgencyWorkspaceKey = 'overview' | 'cases' | 'fleets' | 'notifications' | 'intake' | 'settings'

type SidebarLink = {
  key: AgencyWorkspaceKey | 'create-fleet' | 'invite' | 'admin'
  href: string
  label: string
  icon: ReactNode
}

function DashboardIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M3 3h6v6H3V3Zm8 0h6v4h-6V3ZM3 11h4v6H3v-6Zm6-2h8v8H9V9Z" fill="currentColor" />
    </svg>
  )
}

function FleetIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M2 5.5A2.5 2.5 0 0 1 4.5 3h6A2.5 2.5 0 0 1 13 5.5v1h1.8c.8 0 1.55.38 2.02 1.03l1.16 1.57c.33.45.52 1 .52 1.56v2.84a1 1 0 0 1-1 1H16a2 2 0 1 1-4 0H8a2 2 0 1 1-4 0H3a1 1 0 0 1-1-1V5.5Zm2 0v5.5h8v-5.5a.5.5 0 0 0-.5-.5h-7a.5.5 0 0 0-.5.5Zm10.8 3H13v2.5h3.96v-.34a.5.5 0 0 0-.1-.3L15.7 8.84a.5.5 0 0 0-.4-.2Z" fill="currentColor" />
    </svg>
  )
}

function TicketIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M4 3h12a1 1 0 0 1 1 1v3a2 2 0 0 0 0 6v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-6V4a1 1 0 0 1 1-1Zm1 3v8h10V6H5Zm2 2h6v1.5H7V8Zm0 3h4v1.5H7V11Z" fill="currentColor" />
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

function InviteIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 3a3 3 0 1 1 0 6 3 3 0 0 1 0-6ZM4 15.5c0-2.27 3.1-3.5 6-3.5s6 1.23 6 3.5V17H4v-1.5Zm11-10h1.5V4H18v1.5h1.5V7H18v1.5h-1.5V7H15V5.5Z" fill="currentColor" />
    </svg>
  )
}

function NotificationIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path
        d="M10 2.8A4.8 4.8 0 0 0 5.2 7.6v2.13c0 .53-.16 1.05-.46 1.5L3.6 13.02A1 1 0 0 0 4.44 14.6h11.12a1 1 0 0 0 .84-1.58l-1.14-1.73a2.7 2.7 0 0 1-.46-1.5V7.6A4.8 4.8 0 0 0 10 2.8Zm-2.02 13.1a2.1 2.1 0 0 0 4.04 0H7.98Z"
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

function AdminIcon() {
  return (
    <svg viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2 4 4v4c0 4 2.56 7.74 6 9 3.44-1.26 6-5 6-9V4l-6-2Zm0 3.2 3 .97v2.3c0 2.65-1.48 5.15-3 6.33-1.52-1.18-3-3.68-3-6.33v-2.3l3-.97Zm0 1.8A1.75 1.75 0 1 0 10 10.5 1.75 1.75 0 0 0 10 7Zm-2 6c.3-1.22 1.13-2 2-2s1.7.78 2 2H8Z" fill="currentColor" />
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

function WorkspaceSidebarPanel({
  role,
  enabledFeatures,
  active,
  onNavigate,
}: {
  role: PlatformRole
  enabledFeatures: readonly string[]
  active: AgencyWorkspaceKey
  onNavigate?: () => void
}) {
  const workspaceLinks: SidebarLink[] = [
    { key: 'overview', href: '/dashboard', label: 'Overview', icon: <DashboardIcon /> },
  ]
  if (hasPlatformFeature(enabledFeatures, 'cases_workspace')) {
    workspaceLinks.push({ key: 'cases', href: '/dashboard?tab=cases#case-queue', label: 'Cases', icon: <CasesIcon /> })
  }
  if (hasPlatformFeature(enabledFeatures, 'notification_inbox')) {
    workspaceLinks.push({ key: 'notifications', href: '/notifications#notification-inbox', label: 'Notifications', icon: <NotificationIcon /> })
  }
  if (roleHasFleetWorkspace(role) && hasPlatformFeature(enabledFeatures, 'fleet_workspace')) {
    workspaceLinks.push({ key: 'fleets', href: '/my-fleets', label: 'Fleet Directory', icon: <FleetIcon /> })
  }
  if (hasPlatformFeature(enabledFeatures, 'ticket_intake')) {
    workspaceLinks.push({ key: 'intake', href: '/intake', label: 'Ticket Intake', icon: <TicketIcon /> })
  }
  const managementLinks: SidebarLink[] = []
  if (roleCanCreateFleet(role) && hasPlatformFeature(enabledFeatures, 'fleet_creation')) {
    managementLinks.push({ key: 'create-fleet', href: '/my-fleets#create-fleet', label: 'Create Fleet', icon: <FleetIcon /> })
  }
  if (roleCanInvite(role) && hasPlatformFeature(enabledFeatures, 'invite_management')) {
    managementLinks.push({ key: 'invite', href: '/my-fleets#invite-driver', label: 'Send Invite', icon: <InviteIcon /> })
  }

  const secondaryLinks: SidebarLink[] = [
    { key: 'settings', href: '/settings', label: 'Settings', icon: <SettingsIcon /> },
    ...(isStaffRole(role) ? [{ key: 'admin' as const, href: '/admin/dashboard', label: 'Admin Portal', icon: <AdminIcon /> }] : []),
  ]

  return (
    <>
      <div className="workspace-sidebar-header">
        <p className="workspace-sidebar-eyebrow">Workspace</p>
        <p className="workspace-sidebar-title">{role} Operations</p>
        <p className="workspace-sidebar-copy">Use the same navigation model across dashboards, fleets, intake, and case routing.</p>
      </div>

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Workspace</p>
        <div className="workspace-sidebar-links">
          {workspaceLinks.map((item) => (
            <SidebarLinkItem key={item.key} item={item} active={item.key === active} onNavigate={onNavigate} />
          ))}
        </div>
      </div>

      {managementLinks.length ? (
        <div className="workspace-sidebar-group">
          <p className="workspace-sidebar-group-title">Fleet Management</p>
          <div className="workspace-sidebar-links">
            {managementLinks.map((item) => (
              <SidebarLinkItem key={item.key} item={item} active={false} onNavigate={onNavigate} />
            ))}
          </div>
        </div>
      ) : null}

      <div className="workspace-sidebar-group">
        <p className="workspace-sidebar-group-title">Navigation</p>
        <div className="workspace-sidebar-links">
          {secondaryLinks.map((item) => (
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

      {hasPlatformFeature(enabledFeatures, 'ticket_intake') ? (
        <Link href="/intake" className="button-link primary workspace-sidebar-cta" onClick={onNavigate}>
          + Add Traffic Ticket
        </Link>
      ) : null}
    </>
  )
}

export function AgencyWorkspaceLayout({
  role,
  enabledFeatures = [],
  active,
  title,
  description,
  actions,
  children,
}: {
  role: PlatformRole
  enabledFeatures?: readonly string[]
  active: AgencyWorkspaceKey
  title: string
  description: string
  actions?: ReactNode
  children: ReactNode
}) {
  const [drawerOpen, setDrawerOpen] = useState(false)

  return (
    <div className="workspace-shell">
      <div className="workspace-mobile-controls">
        <button
          type="button"
          className="button-link secondary workspace-drawer-toggle"
          aria-expanded={drawerOpen}
          aria-controls="workspace-mobile-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          Workspace Menu
        </button>
        {actions ? <div className="workspace-compact-actions card">{actions}</div> : null}
      </div>

      <div className={`workspace-mobile-drawer ${drawerOpen ? 'open' : ''}`} id="workspace-mobile-drawer">
        <button
          type="button"
          className="workspace-drawer-scrim"
          aria-label="Close workspace navigation"
          onClick={() => setDrawerOpen(false)}
        />
        <div className="workspace-mobile-drawer-card card" role="dialog" aria-modal="true" aria-label="Workspace navigation">
          <div className="workspace-mobile-drawer-header">
            <div>
              <p className="workspace-sidebar-eyebrow">Navigation</p>
              <p className="workspace-sidebar-title">Workspace Menu</p>
            </div>
            <button type="button" className="button-link ghost workspace-drawer-close" onClick={() => setDrawerOpen(false)}>
              Close
            </button>
          </div>
          <div className="workspace-mobile-drawer-body">
            <WorkspaceSidebarPanel role={role} enabledFeatures={enabledFeatures} active={active} onNavigate={() => setDrawerOpen(false)} />
          </div>
        </div>
      </div>

      <div className="workspace-layout">
        <aside className="workspace-sidebar card" aria-label="Workspace navigation">
          <WorkspaceSidebarPanel role={role} enabledFeatures={enabledFeatures} active={active} />
        </aside>

        <section className="workspace-content">
          <header className="page-header">
            <div className="page-header-copy">
              <p className="page-eyebrow">CDL Protect Platform</p>
              <h1 className="page-title">{title}</h1>
              <p className="page-description">{description}</p>
            </div>
            {actions ? <div className="page-header-actions">{actions}</div> : null}
          </header>
          {children}
        </section>
      </div>
    </div>
  )
}
