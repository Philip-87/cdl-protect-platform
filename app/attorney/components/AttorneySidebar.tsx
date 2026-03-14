import Link from 'next/link'
import { SignOutForm } from '@/app/components/SignOutForm'

type AttorneySidebarProps = {
  active:
    | 'dashboard'
    | 'calendar'
    | 'tasks'
    | 'reminders'
    | 'billing'
    | 'communications'
    | 'integrations'
    | 'coverage'
    | 'my-firm'
    | 'onboarding'
}

export default function AttorneySidebar({ active }: AttorneySidebarProps) {
  const isActive = (key: AttorneySidebarProps['active']) => (active === key ? 'primary' : 'secondary')

  return (
    <aside className="attorney-sidebar card">
      <p className="attorney-sidebar-kicker">Attorney Workspace</p>
      <h2 style={{ margin: '0 0 10px 0' }}>Navigation</h2>
      <nav className="attorney-sidebar-nav">
        <Link href="/attorney/dashboard" className={`button-link ${isActive('dashboard')}`}>
          Dashboard
        </Link>
        <Link href="/intake" className="button-link primary">
          + Add Traffic Ticket
        </Link>
        <Link href="/attorney/calendar" className={`button-link ${isActive('calendar')}`}>
          Calendar
        </Link>
        <Link href="/attorney/tasks" className={`button-link ${isActive('tasks')}`}>
          Tasks
        </Link>
        <Link href="/attorney/reminders" className={`button-link ${isActive('reminders')}`}>
          Reminders
        </Link>
        <Link href="/attorney/billing" className={`button-link ${isActive('billing')}`}>
          Billing
        </Link>
        <Link href="/attorney/communications" className={`button-link ${isActive('communications')}`}>
          Communications
        </Link>
        <Link href="/attorney/integrations" className={`button-link ${isActive('integrations')}`}>
          Integrations
        </Link>
        <Link href="/attorney/coverage-fees" className={`button-link ${isActive('coverage')}`}>
          Coverage and Fees
        </Link>
        <Link href="/attorney/my-firm" className={`button-link ${isActive('my-firm')}`}>
          My Firm
        </Link>
        <Link href="/attorney/onboarding" className={`button-link ${isActive('onboarding')}`}>
          Onboarding
        </Link>
        <SignOutForm className="button-link secondary">Sign Out</SignOutForm>
      </nav>
    </aside>
  )
}
