import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { getEnabledFeaturesForRole, hasPlatformFeature, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { importAttorneyCsv, importCasesCsv, importCountyReferenceCsv } from '../actions'
import { AdminMenu } from '../_components/AdminMenu'

function countValue(result: { count: number | null }) {
  return result.count ?? 0
}

export default async function AdminDatabasePage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string }>
}) {
  const params = await searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/admin/login?message=Please%20sign%20in.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('email, full_name, system_role')
    .eq('id', user.id)
    .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('email, full_name, system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ email: string | null; full_name: string | null; system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  if (!isStaffRole(role)) {
    redirect('/dashboard?message=Admin%20database%20requires%20ADMIN%2C%20OPS%2C%20or%20AGENT%20role.')
  }
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  if (!hasPlatformFeature(enabledFeatures, 'admin_database')) {
    redirect('/admin/dashboard?message=Database%20tools%20are%20disabled%20for%20your%20role.')
  }

  const [casesRes, fleetsRes, firmsRes, countiesRes] = await Promise.all([
    supabase.from('cases').select('*', { count: 'exact', head: true }),
    supabase.from('fleets').select('*', { count: 'exact', head: true }),
    supabase.from('attorney_firms').select('*', { count: 'exact', head: true }),
    supabase.from('county_reference').select('*', { count: 'exact', head: true }),
  ])

  return (
    <div style={{ padding: '18px 0 28px' }}>
      <section style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <div>
          <h1 style={{ margin: 0, fontSize: 34 }}>Database Operations</h1>
          <p style={{ margin: '5px 0 0 0', color: '#5e6068', fontSize: 14 }}>
            Bulk upload operational datasets, download templates, and monitor import targets.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Link href="/admin/users" className="button-link secondary">
            Users &amp; Access
          </Link>
          <Link href="/admin/dashboard" className="button-link secondary">
            Back to Overview
          </Link>
        </div>
      </section>

      <AdminMenu active="database" />

      {params?.message ? (
        <section style={{ marginTop: 12 }}>
          <p className="notice">{params.message}</p>
        </section>
      ) : null}

      <section className="summary-grid" style={{ marginTop: 16 }}>
        <article className="metric-card">
          <p className="metric-label">Cases</p>
          <p className="metric-value">{countValue(casesRes)}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Fleets</p>
          <p className="metric-value">{countValue(fleetsRes)}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">Attorney Firms</p>
          <p className="metric-value">{countValue(firmsRes)}</p>
        </article>
        <article className="metric-card">
          <p className="metric-label">County Reference Rows</p>
          <p className="metric-value">{countValue(countiesRes)}</p>
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <div className="section-heading">
          <div>
            <p className="section-eyebrow">Templates</p>
            <h2 className="section-title">Download import guides</h2>
          </div>
        </div>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Start from validated templates to reduce import failures and keep column naming consistent across teams.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <a href="/api/templates/cases-csv" className="button-link secondary">
            Download Cases Template
          </a>
          <a href="/api/templates/cases-csv" className="button-link secondary">
            Download Fleet Intake Template
          </a>
        </div>
      </section>

      <section className="grid-2" style={{ marginTop: 16 }}>
        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Bulk Cases Upload</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Upload agency, fleet, or historical case data. Supported columns include driver name, violation date, court name,
            court date, citation number, and court case number.
          </p>
          <form action={importCasesCsv} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/database" />
            <div>
              <label htmlFor="database-cases-csv-file">Cases CSV file</label>
              <input id="database-cases-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
            </div>
            <button type="submit" className="primary">
              Import Cases
            </button>
          </form>
        </article>

        <article className="card">
          <h2 style={{ margin: '0 0 8px 0' }}>Bulk Attorney Upload</h2>
          <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
            Create or update attorney firms in bulk and optionally attach invite emails or existing users.
          </p>
          <form action={importAttorneyCsv} className="form-grid">
            <input type="hidden" name="redirect_to" value="/admin/database" />
            <div>
              <label htmlFor="database-attorney-csv-file">Attorney CSV file</label>
              <input id="database-attorney-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
            </div>
            <button type="submit" className="primary">
              Import Attorneys
            </button>
          </form>
        </article>
      </section>

      <section className="card" style={{ marginTop: 16 }}>
        <h2 style={{ margin: '0 0 8px 0' }}>County Reference Upload</h2>
        <p style={{ marginTop: 0, color: '#5e6068', fontSize: 14 }}>
          Update county reference data used in attorney coverage, maps, and intake validation.
        </p>
        <form action={importCountyReferenceCsv} className="form-grid">
          <input type="hidden" name="redirect_to" value="/admin/database" />
          <div>
            <label htmlFor="database-counties-csv-file">County CSV file</label>
            <input id="database-counties-csv-file" name="csv_file" type="file" accept=".csv,text/csv" required />
          </div>
          <button type="submit" className="secondary">
            Import Counties
          </button>
        </form>
      </section>
    </div>
  )
}
