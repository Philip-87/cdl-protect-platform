import Link from 'next/link'

type AdminMenuKey = 'dashboard' | 'cases' | 'network' | 'users' | 'database' | 'logs'

const MENU_ITEMS: Array<{ key: AdminMenuKey; href: string; label: string }> = [
  { key: 'dashboard', href: '/admin/dashboard', label: 'Overview' },
  { key: 'cases', href: '/admin/cases', label: 'Cases' },
  { key: 'network', href: '/admin/attorney-network', label: 'Manage Attorney Network' },
  { key: 'users', href: '/admin/users', label: 'Users & Access' },
  { key: 'database', href: '/admin/database', label: 'Database' },
  { key: 'logs', href: '/admin/platform-logs', label: 'Platform Logs' },
]

export function AdminMenu({ active }: { active: AdminMenuKey }) {
  return (
    <nav className="admin-menu" aria-label="Admin sections">
      {MENU_ITEMS.map((item) => (
        <Link
          key={item.key}
          href={item.href}
          className={`admin-menu-link ${item.key === active ? 'active' : ''}`}
        >
          {item.label}
        </Link>
      ))}
    </nav>
  )
}
