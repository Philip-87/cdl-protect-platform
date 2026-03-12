import crypto from 'node:crypto'
import {
  getCaseDisplayDriverName,
  getCaseMetadataRecord,
  getCaseSubmitterEmail,
  getCaseSubmitterName,
  getCaseSubmitterPhone,
  getCaseSubmittedByRole,
} from '@/app/lib/cases/display'
import { syncAttorneyMatchingCoverageForJurisdiction } from '@/app/lib/matching/attorneyCoverageSync'
import { countyNameAliases, countyNamesOverlap, normalizeCountyName } from '@/app/lib/matching/county'
import { createInAppCaseNotification, markQuotePaymentRequestPaid, upsertQuotePaymentRequest } from '@/app/lib/server/quote-payment'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'
import { computeDrivingDistanceMatrix, geocodeAddress, milesBetween } from '@/app/lib/server/geocode'
import { sendEmail } from '@/app/lib/server/email'

const OUTREACH_TOKEN_TTL_DAYS = 7
const PLATFORM_FEE_CENTS = 20000
const ATTORNEY_ROUTE_MATCH_MAX_MILES = 50

type MatchingMode = 'PRICING_AVAILABLE' | 'OUTREACH_SENT' | 'OUTREACH_NONE'
type OutreachType = 'QUOTE_REQUEST' | 'PRICED_MATCH'

type CaseRow = {
  id: string
  owner_id: string | null
  state: string | null
  county: string | null
  court_name: string | null
  court_address: string | null
  court_date: string | null
  court_time: string | null
  citation_number: string | null
  violation_code: string | null
  submitter_email: string | null
  submitter_user_id: string | null
  ocr_text: string | null
  notes: string | null
  metadata: Record<string, unknown> | null
  court_lat: number | null
  court_lng: number | null
  pricing_available?: boolean | null
  attorney_fee_cents?: number | null
  platform_fee_cents?: number | null
  total_price_cents?: number | null
  show_paid_pricing_to_fleet_driver?: boolean | null
  keep_agency_as_primary_contact?: boolean | null
  primary_contact_type?: string | null
  payment_flow_status?: string | null
  quote_requested_at?: string | null
  quote_received_at?: string | null
  payment_request_sent_at?: string | null
  quote_source_attorney_email?: string | null
}

type DirectoryAttorney = {
  id: string
  name: string | null
  email: string
  phone: string | null
  state: string
  address: string | null
  lat: number | null
  lng: number | null
  is_statewide: boolean
  counties: unknown
}

type OutreachRow = {
  id: string
  case_id: string
  law_firm_org_id: string | null
  directory_attorney_id: string | null
  email: string
  outreach_type: OutreachType
  token_expires_at: string
  status: string
  accepted_at: string | null
  quoted_at: string | null
  quoted_amount_cents: number | null
  attorney_notes: string | null
}

type CaseDocumentLink = {
  id: string
  filename: string
  signedUrl: string
}

type FirmContact = {
  firmId: string
  firmName: string
  email: string
  contactName: string
  attorneyUserId: string | null
  hasPlatformAccount: boolean
}

function getMissingColumnName(message: string) {
  const patterns = [
    /column\s+((?:"?[a-zA-Z0-9_]+"?\.)*"?[a-zA-Z0-9_]+"?)\s+does not exist/i,
    /could not find the '([a-zA-Z0-9_]+)' column/i,
  ]

  for (const pattern of patterns) {
    const match = message.match(pattern)
    if (match?.[1]) {
      const candidate = match[1].replace(/"/g, '').split('.').pop()?.trim()
      if (candidate) return candidate
    }
  }

  return null
}

function isSchemaDriftError(message: string, code?: string) {
  return (
    code === 'PGRST204' ||
    /column .* does not exist/i.test(message) ||
    /schema cache/i.test(message) ||
    /could not find the '.*' column/i.test(message)
  )
}

function isMatchingInfrastructureError(message: string) {
  return (
    /relation .* does not exist/i.test(message) ||
    /schema cache/i.test(message) ||
    /column .* does not exist/i.test(message) ||
    /could not find the '.*' column/i.test(message) ||
    /function .* does not exist/i.test(message)
  )
}

function isCaseAssignmentCompatError(message: string) {
  const normalized = String(message ?? '')
  return (
    isSchemaDriftError(normalized) ||
    /case_assignments_law_firm_org_id_fkey/i.test(normalized) ||
    /case_assignments_firm_id_fkey/i.test(normalized) ||
    ((/foreign key constraint/i.test(normalized) || /violates not-null constraint/i.test(normalized)) &&
      /(law_firm_org_id|firm_id)/i.test(normalized)) ||
    (/null value in column/i.test(normalized) && /(law_firm_org_id|firm_id)/i.test(normalized))
  )
}

function normalizeState(value: string | null | undefined) {
  return String(value ?? '').trim().toUpperCase()
}

function normalizeCounty(value: string | null | undefined) {
  return normalizeCountyName(value)
}

function parseJsonArray(value: unknown) {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
}

function isTruthyFlag(value: unknown) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  return text === 'yes' || text === 'true' || text === '1'
}

function isCdlCase(caseRow: CaseRow) {
  const metadata = caseRow.metadata ?? {}
  return isTruthyFlag(metadata['cdl_driver']) || isTruthyFlag(metadata['cdl'])
}

function normalizeCaseRow(record: Record<string, unknown>): CaseRow {
  const parseNumber = (value: unknown) => {
    const num = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(num) ? num : null
  }

  return {
    id: String(record.id ?? ''),
    owner_id: typeof record.owner_id === 'string' ? record.owner_id : null,
    state: typeof record.state === 'string' ? record.state : null,
    county: typeof record.county === 'string' ? record.county : null,
    court_name: typeof record.court_name === 'string' ? record.court_name : null,
    court_address: typeof record.court_address === 'string' ? record.court_address : null,
    court_date: typeof record.court_date === 'string' ? record.court_date : null,
    court_time: typeof record.court_time === 'string' ? record.court_time : null,
    citation_number: typeof record.citation_number === 'string' ? record.citation_number : null,
    violation_code: typeof record.violation_code === 'string' ? record.violation_code : null,
    submitter_email: typeof record.submitter_email === 'string' ? record.submitter_email : null,
    submitter_user_id: typeof record.submitter_user_id === 'string' ? record.submitter_user_id : null,
    ocr_text: typeof record.ocr_text === 'string' ? record.ocr_text : null,
    notes: typeof record.notes === 'string' ? record.notes : null,
    metadata:
      record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? (record.metadata as Record<string, unknown>)
        : null,
    court_lat: parseNumber(record.court_lat),
    court_lng: parseNumber(record.court_lng),
    pricing_available: typeof record.pricing_available === 'boolean' ? record.pricing_available : null,
    attorney_fee_cents: parseNumber(record.attorney_fee_cents),
    platform_fee_cents: parseNumber(record.platform_fee_cents),
    total_price_cents: parseNumber(record.total_price_cents),
    show_paid_pricing_to_fleet_driver:
      typeof record.show_paid_pricing_to_fleet_driver === 'boolean' ? record.show_paid_pricing_to_fleet_driver : null,
    keep_agency_as_primary_contact:
      typeof record.keep_agency_as_primary_contact === 'boolean' ? record.keep_agency_as_primary_contact : null,
    primary_contact_type: typeof record.primary_contact_type === 'string' ? record.primary_contact_type : null,
    payment_flow_status: typeof record.payment_flow_status === 'string' ? record.payment_flow_status : null,
    quote_requested_at: typeof record.quote_requested_at === 'string' ? record.quote_requested_at : null,
    quote_received_at: typeof record.quote_received_at === 'string' ? record.quote_received_at : null,
    payment_request_sent_at: typeof record.payment_request_sent_at === 'string' ? record.payment_request_sent_at : null,
    quote_source_attorney_email: typeof record.quote_source_attorney_email === 'string' ? record.quote_source_attorney_email : null,
  }
}

async function fetchCaseRow(caseId: string) {
  const supabase = createServiceRoleClient()
  const columns = [
    'id',
    'owner_id',
    'state',
    'county',
    'court_name',
    'court_address',
    'court_date',
    'court_time',
    'citation_number',
    'violation_code',
    'submitter_email',
    'submitter_user_id',
    'ocr_text',
    'notes',
    'metadata',
    'court_lat',
    'court_lng',
    'pricing_available',
    'attorney_fee_cents',
    'platform_fee_cents',
    'total_price_cents',
    'show_paid_pricing_to_fleet_driver',
    'keep_agency_as_primary_contact',
    'primary_contact_type',
    'payment_flow_status',
    'quote_requested_at',
    'quote_received_at',
    'payment_request_sent_at',
    'quote_source_attorney_email',
  ]

  while (columns.length) {
    const caseRes = await supabase
      .from('cases')
      .select(columns.join(', '))
      .eq('id', caseId)
      .maybeSingle<Record<string, unknown>>()

    if (!caseRes.error && caseRes.data) {
      return {
        data: normalizeCaseRow(caseRes.data),
        error: '',
      }
    }

    if (!caseRes.error) {
      return {
        data: null,
        error: 'Case not found.',
      }
    }

    if (!isSchemaDriftError(caseRes.error.message, caseRes.error.code)) {
      return {
        data: null,
        error: caseRes.error.message,
      }
    }

    const missingColumn = getMissingColumnName(caseRes.error.message)
    if (missingColumn && columns.includes(missingColumn)) {
      columns.splice(columns.indexOf(missingColumn), 1)
      continue
    }

    return {
      data: null,
      error: caseRes.error.message,
    }
  }

  return {
    data: null,
    error: 'Case not found.',
  }
}

async function updateCaseSafe(caseId: string, patch: Record<string, unknown>) {
  const supabase = createServiceRoleClient()
  const payload = { ...patch }

  while (Object.keys(payload).length) {
    const update = await supabase.from('cases').update(payload).eq('id', caseId)
    if (!update.error) {
      return { ok: true as const }
    }

    if (!isSchemaDriftError(update.error.message, update.error.code)) {
      return { ok: false as const, error: update.error.message }
    }

    const missingColumn = getMissingColumnName(update.error.message)
    if (missingColumn && missingColumn in payload) {
      delete payload[missingColumn]
      continue
    }

    return { ok: false as const, error: update.error.message }
  }

  return { ok: true as const }
}

async function insertCaseQuoteSafe(payload: Record<string, unknown>) {
  const supabase = createServiceRoleClient()
  const insertPayload = { ...payload }

  while (Object.keys(insertPayload).length) {
    const insert = await supabase
      .from('case_quotes')
      .insert(insertPayload)
      .select('id, total_cents')
      .single<{ id: string; total_cents: number }>()

    if (!insert.error && insert.data?.id) {
      return { ok: true as const, data: insert.data }
    }

    if (!insert.error) {
      return { ok: false as const, error: 'Could not create case quote.' }
    }

    if (!isSchemaDriftError(insert.error.message, insert.error.code)) {
      return { ok: false as const, error: insert.error.message }
    }

    const missingColumn = getMissingColumnName(insert.error.message)
    if (missingColumn && missingColumn in insertPayload) {
      delete insertPayload[missingColumn]
      continue
    }

    return { ok: false as const, error: insert.error.message }
  }

  return { ok: false as const, error: 'Could not create case quote.' }
}

function getBaseUrl() {
  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.SITE_URL,
    process.env.APP_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL,
    process.env.VERCEL_URL,
    process.env.NODE_ENV !== 'production' ? 'http://localhost:3000' : null,
  ]

  for (const candidate of candidates) {
    const raw = String(candidate ?? '').trim()
    if (!raw) continue

    let normalized = raw
    if (!/^https?:\/\//i.test(normalized)) {
      const isLocalHost = /^localhost(?::\d+)?$/i.test(normalized) || /^127\.0\.0\.1(?::\d+)?$/.test(normalized)
      normalized = `${isLocalHost ? 'http' : 'https'}://${normalized}`
    }

    try {
      return new URL(normalized).toString().replace(/\/$/, '')
    } catch {
      continue
    }
  }

  return null
}

function createRawToken() {
  return crypto.randomBytes(32).toString('hex')
}

function hashToken(rawToken: string) {
  return crypto.createHash('sha256').update(rawToken, 'utf8').digest('hex')
}

async function setCaseStatus(caseId: string, toStatus: string, reason: string, metadata?: Record<string, unknown>) {
  const supabase = createServiceRoleClient()
  const transition = await supabase.rpc('transition_case_status', {
    p_case_id: caseId,
    p_to_status: toStatus,
    p_reason: reason,
    p_metadata: metadata ?? null,
  })

  if (transition.error) {
    await supabase
      .from('cases')
      .update({
        status: toStatus,
        updated_at: new Date().toISOString(),
      })
      .eq('id', caseId)
  }
}

async function createCaseEvent(params: {
  caseId: string
  type: string
  summary: string
  metadata?: Record<string, unknown>
  actorId?: string | null
}) {
  const supabase = createServiceRoleClient()
  await supabase.from('case_events').insert({
    case_id: params.caseId,
    event_type: params.type,
    event_summary: params.summary,
    metadata: params.metadata ?? {},
    actor_id: params.actorId ?? null,
  })
}

function escapeHtml(value: unknown) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function formatUsd(cents: number | null | undefined) {
  const value = Number(cents ?? 0)
  if (!Number.isFinite(value) || value <= 0) return '$0.00'
  return `$${(value / 100).toFixed(2)}`
}

function getCasePrimaryContact(caseRow: CaseRow) {
  const metadata = getCaseMetadataRecord(caseRow)
  const uploaderName =
    String(metadata['submitter_name'] ?? metadata['uploader_name'] ?? getCaseSubmitterName(caseRow) ?? '').trim() || 'Submitter'
  const uploaderEmail =
    String(metadata['submitter_email'] ?? metadata['uploader_email'] ?? caseRow.submitter_email ?? '').trim().toLowerCase() || ''
  const uploaderPhone = String(metadata['submitter_phone'] ?? metadata['uploader_phone'] ?? getCaseSubmitterPhone(caseRow) ?? '').trim()
  const keepAgencyPrimary =
    caseRow.keep_agency_as_primary_contact === true || String(caseRow.primary_contact_type ?? '').trim().toUpperCase() === 'AGENCY'

  return {
    name: uploaderName,
    email: uploaderEmail,
    phone: uploaderPhone,
    role: keepAgencyPrimary ? 'AGENCY' : getCaseSubmittedByRole(caseRow) || 'SUBMITTER',
    keepAgencyPrimary,
    driverName: getCaseDisplayDriverName(caseRow),
    driverEmail: String(metadata['driver_email'] ?? '').trim().toLowerCase() || '',
  }
}

async function loadCaseDocumentLinks(caseId: string) {
  const supabase = createServiceRoleClient()
  const docsRes = await supabase
    .from('documents')
    .select('id, filename, storage_path')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })

  if (docsRes.error || !docsRes.data?.length) {
    return [] as CaseDocumentLink[]
  }

  const docs: CaseDocumentLink[] = []
  for (const row of docsRes.data as Array<{ id: string; filename: string | null; storage_path: string | null }>) {
    const storagePath = String(row.storage_path ?? '').trim()
    if (!storagePath) continue

    const signed = await supabase.storage.from('case-documents').createSignedUrl(storagePath, 60 * 60 * 24 * 7)
    if (signed.error || !signed.data?.signedUrl) continue

    docs.push({
      id: row.id,
      filename: String(row.filename ?? 'Ticket file').trim() || 'Ticket file',
      signedUrl: signed.data.signedUrl,
    })
  }

  return docs
}

async function loadFirmContact(firmId: string) {
  const supabase = createServiceRoleClient()
  const firmRes = await supabase
    .from('attorney_firms')
    .select('id, company_name, contact_name, email')
    .eq('id', firmId)
    .maybeSingle<{ id: string; company_name: string | null; contact_name: string | null; email: string | null }>()

  if (firmRes.error || !firmRes.data) {
    return null
  }

  const membershipRes = await supabase
    .from('attorney_firm_memberships')
    .select('user_id')
    .eq('firm_id', firmId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ user_id: string | null }>()

  const attorneyUserId = membershipRes.data?.user_id ?? null
  let profileName = ''
  let profileEmail = ''
  if (attorneyUserId) {
    const profileByUser = await supabase
      .from('profiles')
      .select('email, full_name')
      .eq('user_id', attorneyUserId)
      .maybeSingle<{ email: string | null; full_name: string | null }>()

    const profileById =
      profileByUser.data ||
      (
        await supabase
          .from('profiles')
          .select('email, full_name')
          .eq('id', attorneyUserId)
          .maybeSingle<{ email: string | null; full_name: string | null }>()
      ).data

    profileName = String(profileById?.full_name ?? '').trim()
    profileEmail = String(profileById?.email ?? '').trim().toLowerCase()
  }

  const email = profileEmail || String(firmRes.data.email ?? '').trim().toLowerCase()
  if (!email) {
    return null
  }

  return {
    firmId,
    firmName: String(firmRes.data.company_name ?? '').trim() || 'Attorney Firm',
    email,
    contactName:
      profileName || String(firmRes.data.contact_name ?? '').trim() || String(firmRes.data.company_name ?? '').trim() || email,
    attorneyUserId,
    hasPlatformAccount: Boolean(attorneyUserId),
  } satisfies FirmContact
}

async function lookupAttorneyProfileByEmail(email: string) {
  const supabase = createServiceRoleClient()
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) {
    return {
      hasPlatformAccount: false,
      attorneyUserId: null,
      fullName: '',
    }
  }

  const profileRes = await supabase
    .from('profiles')
    .select('id, user_id, full_name')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle<{ id: string; user_id: string | null; full_name: string | null }>()

  return {
    hasPlatformAccount: Boolean(profileRes.data?.user_id || profileRes.data?.id),
    attorneyUserId: profileRes.data?.user_id || profileRes.data?.id || null,
    fullName: String(profileRes.data?.full_name ?? '').trim(),
  }
}

async function buildAttorneyInviteLink(email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null

  const account = await lookupAttorneyProfileByEmail(normalizedEmail)
  if (account.hasPlatformAccount) return null

  const supabase = createServiceRoleClient()
  const baseUrl = getBaseUrl()
  const fallbackUrl = baseUrl ? `${baseUrl}/signup?email=${encodeURIComponent(normalizedEmail)}` : null

  try {
    const invite = await supabase.auth.admin.generateLink({
      type: 'invite',
      email: normalizedEmail,
      options: baseUrl
        ? {
            redirectTo: `${baseUrl}/auth/confirm?next=/attorney/dashboard&set_password=1`,
          }
        : undefined,
    })

    if (invite.error) {
      console.error('Failed to generate attorney invite link:', invite.error.message)
      return fallbackUrl
    }

    return invite.data?.properties?.action_link ?? fallbackUrl
  } catch (error) {
    console.error('Attorney invite generation threw an exception:', error)
    return fallbackUrl
  }
}

function buildAttorneyOutreachEmail(params: {
  caseRow: CaseRow
  rawToken: string
  baseUrl: string
  outreachType: OutreachType
  documents: CaseDocumentLink[]
  dashboardUrl?: string | null
  inviteUrl?: string | null
  attorneyFeeCents?: number | null
  submitterHasPaid?: boolean
}) {
  const acceptUrl = `${params.baseUrl}/attorney/respond/${encodeURIComponent(params.rawToken)}/accept`
  const denyUrl = `${params.baseUrl}/attorney/respond/${encodeURIComponent(params.rawToken)}/deny`
  const primaryContact = getCasePrimaryContact(params.caseRow)
  const metadata = getCaseMetadataRecord(params.caseRow)
  const isPricedMatch = params.outreachType === 'PRICED_MATCH'
  const totalCents = isPricedMatch ? Number(params.attorneyFeeCents ?? 0) + PLATFORM_FEE_CENTS : null
  const courtDateTime = [params.caseRow.court_date, params.caseRow.court_time].filter(Boolean).join(' ').trim() || '-'
  const reference = params.caseRow.citation_number || params.caseRow.id
  const countyState = [params.caseRow.county, params.caseRow.state].filter(Boolean).join(', ').trim() || 'Jurisdiction pending'
  const bodyTitle = isPricedMatch ? 'Attorney Assignment Ready' : 'Attorney Quote Request'
  const eyebrow = isPricedMatch ? 'DIRECT PRICED MATCH' : 'LOCAL ATTORNEY OUTREACH'
  const bodyCopy = isPricedMatch
    ? params.submitterHasPaid
      ? 'The submitter completed payment for this ticket. Review the case packet and confirm the assignment through the secure link below.'
      : 'A new ticket matched your pricing profile. Review the case packet and confirm availability through the secure link below so routing can continue without delay.'
    : 'Pricing is not available yet for this court. Review the ticket packet and submit your attorney fee through the secure quote page.'
  const ctaLabel = isPricedMatch ? 'Review and Accept Case' : 'Open Quote Submission'
  const inviteLabel = isPricedMatch ? 'Create attorney profile' : 'Join CDL Protect to respond'
  const ocrSnippet = String(params.caseRow.ocr_text ?? '').trim()
  const ocrHtml = ocrSnippet ? escapeHtml(ocrSnippet.slice(0, 1800)).replace(/\n/g, '<br/>') : ''
  const notes = params.caseRow.notes || String(metadata['notes'] ?? '') || '-'
  const paymentStatusLabel = isPricedMatch ? (params.submitterHasPaid ? 'Client paid' : 'Pending client checkout') : 'Fee requested'
  const docsHtml = params.documents.length
    ? params.documents
        .map(
          (doc) =>
            `<tr><td style="padding:0 0 10px 0;"><a href="${escapeHtml(doc.signedUrl)}" style="color:#254c7d;text-decoration:none;font-weight:600;">${escapeHtml(
              doc.filename
            )}</a><div style="font-size:12px;color:#6a7280;margin-top:2px;">Secure download link</div></td></tr>`
        )
        .join('')
    : '<tr><td style="padding:0;color:#6a7280;">No ticket files were attached.</td></tr>'
  const summaryRows = [
    ['Reference', reference],
    ['Workflow', isPricedMatch ? 'Priced assignment' : 'Quote request'],
    ['Status', paymentStatusLabel],
    ['Driver', primaryContact.driverName || '-'],
    ['Jurisdiction', countyState],
    ['Court', params.caseRow.court_name || '-'],
    ['Court address', params.caseRow.court_address || '-'],
    ['Court date/time', courtDateTime],
    ['Violation', params.caseRow.violation_code || '-'],
    ['Primary contact', `${primaryContact.name} (${primaryContact.role})`],
    ['Contact email', primaryContact.email || '-'],
    ['Contact phone', primaryContact.phone || '-'],
    ['Notes', notes],
  ]
  const summaryHtml = summaryRows
    .map(
      ([label, value]) =>
        `<tr><td style="padding:0 0 10px 0;vertical-align:top;width:170px;font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#7a6c4e;">${escapeHtml(
          label
        )}</td><td style="padding:0 0 10px 0;font-size:15px;color:#162334;">${escapeHtml(value)}</td></tr>`
    )
    .join('')
  const pricingHtml =
    isPricedMatch && totalCents !== null
      ? `
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:separate;border-spacing:0 10px;">
          <tr>
            <td style="width:33.33%;padding:18px;border:1px solid #d8deea;border-radius:16px;background:#f9fbff;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#7a6c4e;">Attorney Fee</div>
              <div style="font-size:24px;font-weight:700;color:#162334;margin-top:6px;">${escapeHtml(formatUsd(params.attorneyFeeCents ?? 0))}</div>
            </td>
            <td style="width:33.33%;padding:18px;border:1px solid #d8deea;border-radius:16px;background:#f9fbff;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#7a6c4e;">Platform Fee</div>
              <div style="font-size:24px;font-weight:700;color:#162334;margin-top:6px;">${escapeHtml(formatUsd(PLATFORM_FEE_CENTS))}</div>
            </td>
            <td style="width:33.33%;padding:18px;border:1px solid #b9c8df;border-radius:16px;background:#edf3ff;">
              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;color:#7a6c4e;">Client Total</div>
              <div style="font-size:24px;font-weight:700;color:#162334;margin-top:6px;">${escapeHtml(formatUsd(totalCents))}</div>
            </td>
          </tr>
        </table>
      `
      : ''

  const html = `
    <div style="margin:0;padding:32px 16px;background:#eef1e8;font-family:Arial,Helvetica,sans-serif;color:#162334;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:720px;margin:0 auto;border-collapse:collapse;">
        <tr>
          <td style="padding:0 0 16px;font-size:13px;letter-spacing:0.18em;text-transform:uppercase;color:#b5852d;font-weight:700;">CDL Protect Platform</td>
        </tr>
        <tr>
          <td style="background:linear-gradient(135deg,#1d3557 0%,#2f5d8a 100%);padding:32px;border-radius:28px 28px 20px 20px;color:#ffffff;">
            <div style="font-size:12px;letter-spacing:0.16em;text-transform:uppercase;color:#e8c78a;font-weight:700;margin-bottom:14px;">${escapeHtml(
              eyebrow
            )}</div>
            <div style="font-size:34px;line-height:1.15;font-weight:700;margin:0 0 12px;">${escapeHtml(bodyTitle)}</div>
            <div style="font-size:16px;line-height:1.7;color:#e7edf6;max-width:560px;">${escapeHtml(bodyCopy)}</div>
          </td>
        </tr>
        <tr>
          <td style="background:#ffffff;padding:28px;border:1px solid #d9dfeb;border-top:0;border-radius:0 0 28px 28px;">
            ${pricingHtml}
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:collapse;">
              <tr>
                <td style="padding:20px;border:1px solid #d8deea;border-radius:18px;background:#fcfcfb;">
                  <div style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#7a6c4e;font-weight:700;margin-bottom:18px;">Case Summary</div>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
                    ${summaryHtml}
                  </table>
                </td>
              </tr>
            </table>
            ${
              ocrHtml
                ? `
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:collapse;">
                    <tr>
                      <td style="padding:20px;border:1px solid #d8deea;border-radius:18px;background:#f9fbff;">
                        <div style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#7a6c4e;font-weight:700;margin-bottom:12px;">OCR Extract</div>
                        <div style="font-size:14px;line-height:1.7;color:#314154;">${ocrHtml}</div>
                      </td>
                    </tr>
                  </table>
                `
                : ''
            }
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:collapse;">
              <tr>
                <td style="padding:20px;border:1px solid #d8deea;border-radius:18px;background:#fcfcfb;">
                  <div style="font-size:13px;letter-spacing:0.14em;text-transform:uppercase;color:#7a6c4e;font-weight:700;margin-bottom:12px;">Ticket Files</div>
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="border-collapse:collapse;">
                    ${docsHtml}
                  </table>
                </td>
              </tr>
            </table>
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 24px;border-collapse:collapse;">
              <tr>
                <td style="padding:0 12px 12px 0;">
                  <a href="${acceptUrl}" style="display:block;padding:16px 18px;text-align:center;background:#1f5ea8;color:#ffffff;text-decoration:none;border-radius:14px;font-weight:700;">${escapeHtml(
                    ctaLabel
                  )}</a>
                </td>
                <td style="padding:0 0 12px 12px;">
                  <a href="${denyUrl}" style="display:block;padding:16px 18px;text-align:center;background:#fff4f2;color:#b33a2b;text-decoration:none;border-radius:14px;font-weight:700;border:1px solid #f1c6bf;">Deny Case</a>
                </td>
              </tr>
            </table>
            ${
              params.dashboardUrl || params.inviteUrl
                ? `
                  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:0 0 16px;border-collapse:collapse;">
                    ${
                      params.dashboardUrl
                        ? `
                          <tr>
                            <td style="padding:0 0 10px;">
                              <a href="${escapeHtml(params.dashboardUrl)}" style="color:#254c7d;text-decoration:none;font-weight:700;">Open attorney dashboard</a>
                            </td>
                          </tr>
                        `
                        : ''
                    }
                    ${
                      params.inviteUrl
                        ? `
                          <tr>
                            <td style="padding:0;">
                              <a href="${escapeHtml(params.inviteUrl)}" style="color:#254c7d;text-decoration:none;font-weight:700;">${escapeHtml(
                                inviteLabel
                              )}</a>
                              <div style="font-size:13px;color:#6a7280;margin-top:4px;">Use this link to create your CDL Protect attorney profile and manage the case inside the platform.</div>
                            </td>
                          </tr>
                        `
                        : ''
                    }
                  </table>
                `
                : ''
            }
            <div style="font-size:12px;line-height:1.7;color:#6a7280;border-top:1px solid #e5e9f1;padding-top:14px;">
              Secure response links expire in ${OUTREACH_TOKEN_TTL_DAYS} days. If the buttons do not open, copy the links from the plain-text email version.
            </div>
          </td>
        </tr>
      </table>
    </div>
  `.trim()

  const textParts = [
    bodyTitle,
    eyebrow,
    bodyCopy,
    `Reference: ${reference}`,
    `Workflow: ${isPricedMatch ? 'Priced assignment' : 'Quote request'}`,
    `Status: ${paymentStatusLabel}`,
    `Primary contact: ${primaryContact.name} (${primaryContact.role})`,
    `Primary contact email: ${primaryContact.email || '-'}`,
    `Primary contact phone: ${primaryContact.phone || '-'}`,
    `Driver: ${primaryContact.driverName || '-'}`,
    `Ticket number: ${params.caseRow.citation_number || '-'}`,
    `Violation: ${params.caseRow.violation_code || '-'}`,
    `State: ${params.caseRow.state || '-'}`,
    `County: ${params.caseRow.county || '-'}`,
    `Court: ${params.caseRow.court_name || '-'}`,
    `Court address: ${params.caseRow.court_address || '-'}`,
    `Court date/time: ${courtDateTime}`,
    isPricedMatch ? `Attorney fee: ${formatUsd(params.attorneyFeeCents ?? 0)}` : '',
    isPricedMatch ? `Platform fee: ${formatUsd(PLATFORM_FEE_CENTS)}` : '',
    isPricedMatch && totalCents !== null ? `Client total: ${formatUsd(totalCents)}` : '',
    `Notes: ${notes}`,
    ocrSnippet ? `OCR extract: ${ocrSnippet.slice(0, 1800)}` : '',
    params.documents.length
      ? `Ticket files: ${params.documents.map((doc) => `${doc.filename}: ${doc.signedUrl}`).join(' | ')}`
      : 'Ticket files: none',
    `Accept: ${acceptUrl}`,
    `Deny: ${denyUrl}`,
    params.dashboardUrl ? `Dashboard: ${params.dashboardUrl}` : '',
    params.inviteUrl ? `Create profile: ${params.inviteUrl}` : '',
    `These secure links expire in ${OUTREACH_TOKEN_TTL_DAYS} days.`,
  ].filter(Boolean)

  return {
    html,
    text: textParts.join('\n'),
  }
}

function buildAttorneyOutreachSubject(params: {
  caseRow: CaseRow
  outreachType: OutreachType
  submitterHasPaid?: boolean
}) {
  const reference = params.caseRow.citation_number || params.caseRow.id
  const countyState = [params.caseRow.county, params.caseRow.state].filter(Boolean).join(', ').trim()

  if (params.outreachType === 'PRICED_MATCH') {
    const prefix = params.submitterHasPaid ? 'Client paid' : 'New priced assignment'
    return [prefix, reference, countyState].filter(Boolean).join(' | ')
  }

  return ['Attorney quote request', reference, countyState].filter(Boolean).join(' | ')
}

function buildSubmitterQuoteReadyEmail(params: {
  caseRow: CaseRow
  checkoutUrl: string
  attorneyFeeCents: number
  totalCents: number
}) {
  const primaryContact = getCasePrimaryContact(params.caseRow)
  const subject = 'Your CDL Protect payment request is ready'
  const html = `
    <div style="font-family: Arial, sans-serif; max-width: 680px; margin: 0 auto; color: #122033;">
      <h2>Quote Received</h2>
      <p>We received an attorney quote for your traffic ticket case.</p>
      <ul>
        <li><strong>Case:</strong> ${escapeHtml(params.caseRow.citation_number || params.caseRow.id)}</li>
        <li><strong>Attorney Fee:</strong> ${escapeHtml(formatUsd(params.attorneyFeeCents))}</li>
        <li><strong>Platform Fee:</strong> ${escapeHtml(formatUsd(PLATFORM_FEE_CENTS))}</li>
        <li><strong>Total Due:</strong> ${escapeHtml(formatUsd(params.totalCents))}</li>
      </ul>
      <p><a href="${escapeHtml(params.checkoutUrl)}">Pay securely now</a></p>
      <p>You can also open the case in the CDL Protect dashboard to review and pay.</p>
      <p style="color:#5b6472;">Primary contact: ${escapeHtml(primaryContact.name)} (${escapeHtml(primaryContact.email || '-')})</p>
    </div>
  `.trim()
  const text = [
    'Quote received.',
    `Case: ${params.caseRow.citation_number || params.caseRow.id}`,
    `Attorney fee: ${formatUsd(params.attorneyFeeCents)}`,
    `Platform fee: ${formatUsd(PLATFORM_FEE_CENTS)}`,
    `Total due: ${formatUsd(params.totalCents)}`,
    `Pay now: ${params.checkoutUrl}`,
  ].join('\n')

  return { subject, html, text }
}

async function findBestPricingMatch(params: {
  state: string | null | undefined
  county: string | null | undefined
  isCdl: boolean
}) {
  const supabase = createServiceRoleClient()
  const state = normalizeState(params.state)
  const county = normalizeCounty(params.county)
  if (!state || !county) return null
  const countyAliases = countyNameAliases(params.county)

  const { data, error } = await supabase
    .from('attorney_pricing')
    .select('id, law_firm_org_id, cdl_fee_cents, non_cdl_fee_cents')
    .eq('state', state)
    .in('county', countyAliases.length ? countyAliases : [county])
    .eq('is_active', true)
    .order(params.isCdl ? 'cdl_fee_cents' : 'non_cdl_fee_cents', { ascending: true })
    .limit(12)

  if (error || !data?.length) return null

  const pricingRows = data as Array<{
    law_firm_org_id: string
    cdl_fee_cents: number
    non_cdl_fee_cents: number
  }>
  const firmIds = [...new Set(pricingRows.map((row) => row.law_firm_org_id).filter(Boolean))]
  let existingFirmIds = new Set<string>()
  let activeFirmIds = new Set<string>()
  if (!firmIds.length) return null

  const activeFirmRes = await supabase.from('attorney_firms').select('id').in('id', firmIds).eq('is_active', true)
  if (!activeFirmRes.error) {
    activeFirmIds = new Set(
      (activeFirmRes.data ?? []).map((row) => String((row as { id?: string }).id ?? '')).filter(Boolean)
    )
  }

  const existingFirmRes = await supabase.from('attorney_firms').select('id').in('id', firmIds)
  if (!existingFirmRes.error) {
    existingFirmIds = new Set(
      (existingFirmRes.data ?? []).map((row) => String((row as { id?: string }).id ?? '')).filter(Boolean)
    )
  }

  const best =
    pricingRows.find((row) => activeFirmIds.has(row.law_firm_org_id)) ??
    pricingRows.find((row) => existingFirmIds.has(row.law_firm_org_id))

  if (!best) return null

  return {
    firmId: best.law_firm_org_id,
    attorneyFeeCents: params.isCdl ? Number(best.cdl_fee_cents) : Number(best.non_cdl_fee_cents),
  }
}

export async function previewAttorneyPricing(params: {
  state: string | null | undefined
  county: string | null | undefined
  isCdl: boolean
}) {
  const pricing = await findBestPricingMatch(params)
  if (!pricing) {
    return {
      pricingAvailable: false as const,
      attorneyFeeCents: 0,
      platformFeeCents: PLATFORM_FEE_CENTS,
      totalCents: 0,
      firmId: null,
    }
  }

  return {
    pricingAvailable: true as const,
    attorneyFeeCents: pricing.attorneyFeeCents,
    platformFeeCents: PLATFORM_FEE_CENTS,
    totalCents: pricing.attorneyFeeCents + PLATFORM_FEE_CENTS,
    firmId: pricing.firmId,
  }
}

export async function pricingAvailable(caseRow: CaseRow) {
  return findBestPricingMatch({
    state: caseRow.state,
    county: caseRow.county,
    isCdl: isCdlCase(caseRow),
  })
}

async function supersedePendingMatchingArtifacts(params: {
  caseId: string
  exceptFirmId?: string | null
  reason: string
}) {
  const supabase = createServiceRoleClient()
  const nowIso = new Date().toISOString()

  const outreachUpdate = await supabase
    .from('attorney_outreach')
    .update({
      status: 'SUPERSEDED',
      responded_at: nowIso,
    })
    .eq('case_id', params.caseId)
    .eq('status', 'PENDING')

  if (outreachUpdate.error && !isMatchingInfrastructureError(outreachUpdate.error.message)) {
    return {
      ok: false as const,
      error: outreachUpdate.error.message,
    }
  }

  const assignments = await loadCaseAssignmentsForCase(params.caseId)
  if (!assignments.ok) {
    return assignments
  }

  const assignmentIds = assignments.rows
    .filter((row) => !row.accepted_at && !row.declined_at)
    .filter((row) => (params.exceptFirmId ? row.firmId !== params.exceptFirmId : true))
    .map((row) => row.id)

  if (!assignmentIds.length) {
    return {
      ok: true as const,
    }
  }

  const assignmentRes = await supabase
    .from('case_assignments')
    .update({
      declined_at: nowIso,
      decline_reason: params.reason,
      accepted_at: null,
    })
    .in('id', assignmentIds)
  if (assignmentRes.error && !isMatchingInfrastructureError(assignmentRes.error.message)) {
    return {
      ok: false as const,
      error: assignmentRes.error.message,
    }
  }

  return {
    ok: true as const,
  }
}

async function ensureAcceptedCaseAssignment(params: {
  caseId: string
  firmId: string
  actorUserId?: string | null
}) {
  const supabase = createServiceRoleClient()
  const existingRes = await loadCaseAssignmentsForCase(params.caseId)
  if (!existingRes.ok) return existingRes
  const existing = existingRes.rows.find((row) => row.firmId === params.firmId) ?? null

  if (existing?.id && existing.accepted_at) {
    return {
      ok: true as const,
      assignmentId: existing.id,
      reused: true,
    }
  }

  if (existing?.id && !existing.declined_at) {
    const revive = await supabase
      .from('case_assignments')
      .update({
        accepted_at: new Date().toISOString(),
        declined_at: null,
        decline_reason: null,
      })
      .eq('id', existing.id)

    if (revive.error) {
      return {
        ok: false as const,
        error: revive.error.message,
      }
    }

    return {
      ok: true as const,
      assignmentId: existing.id,
      reused: true,
    }
  }

  const assignmentInsert = await insertCaseAssignment({
    caseId: params.caseId,
    firmId: params.firmId,
    actorUserId: params.actorUserId ?? null,
    acceptedAt: new Date().toISOString(),
  })

  if (!assignmentInsert.ok || !assignmentInsert.assignmentId) {
    return {
      ok: false as const,
      error: assignmentInsert.error || 'Could not create case assignment.',
    }
  }

  return {
    ok: true as const,
    assignmentId: assignmentInsert.assignmentId,
    reused: false,
  }
}

async function ensurePendingCaseAssignment(params: {
  caseId: string
  firmId: string
  actorUserId?: string | null
}) {
  const existingRes = await loadCaseAssignmentsForCase(params.caseId)
  if (!existingRes.ok) return existingRes
  const existing = existingRes.rows.find((row) => row.firmId === params.firmId) ?? null

  if (existing?.id && !existing.declined_at) {
    return {
      ok: true as const,
      assignmentId: existing.id,
      reused: true,
    }
  }

  const assignmentInsert = await insertCaseAssignment({
    caseId: params.caseId,
    firmId: params.firmId,
    actorUserId: params.actorUserId ?? null,
    acceptedAt: null,
  })

  if (!assignmentInsert.ok || !assignmentInsert.assignmentId) {
    return {
      ok: false as const,
      error: assignmentInsert.error || 'Could not create pending case assignment.',
    }
  }

  return {
    ok: true as const,
    assignmentId: assignmentInsert.assignmentId,
    reused: false,
  }
}

type CaseAssignmentCompatRow = {
  id: string
  firmId: string | null
  accepted_at: string | null
  declined_at: string | null
}

async function loadCaseAssignmentsForCase(caseId: string) {
  const supabase = createServiceRoleClient()
  const selectVariants = [
    'id, offered_at, accepted_at, declined_at, firm_id, law_firm_org_id',
    'id, offered_at, accepted_at, declined_at, law_firm_org_id',
    'id, offered_at, accepted_at, declined_at, firm_id',
  ]

  for (const selectClause of selectVariants) {
    const res = await supabase
      .from('case_assignments')
      .select(selectClause)
      .eq('case_id', caseId)
      .order('offered_at', { ascending: false })

    if (res.error) {
      if (isSchemaDriftError(res.error.message, res.error.code)) {
        continue
      }

      return {
        ok: false as const,
        error: res.error.message,
      }
    }

    const rows = (res.data ?? []).map((row) => {
      const raw = row as unknown as Record<string, unknown>
      return {
        id: String(raw.id ?? ''),
        firmId:
          typeof raw.law_firm_org_id === 'string'
            ? raw.law_firm_org_id
            : typeof raw.firm_id === 'string'
              ? raw.firm_id
              : null,
        accepted_at: typeof raw.accepted_at === 'string' ? raw.accepted_at : null,
        declined_at: typeof raw.declined_at === 'string' ? raw.declined_at : null,
      } satisfies CaseAssignmentCompatRow
    })

    return {
      ok: true as const,
      rows,
    }
  }

  return {
    ok: true as const,
    rows: [] as CaseAssignmentCompatRow[],
  }
}

async function insertCaseAssignment(params: {
  caseId: string
  firmId: string
  actorUserId?: string | null
  acceptedAt?: string | null
}) {
  const supabase = createServiceRoleClient()
  const nowIso = new Date().toISOString()
  const offeredAt = nowIso
  const expiresAt = new Date(Date.now() + OUTREACH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  const variants: Array<Record<string, unknown>> = [
    {
      case_id: params.caseId,
      firm_id: params.firmId,
      offered_by: params.actorUserId ?? null,
      offered_at: offeredAt,
      ...(params.acceptedAt ? { accepted_at: params.acceptedAt } : {}),
      expires_at: expiresAt,
    },
    {
      case_id: params.caseId,
      law_firm_org_id: params.firmId,
      firm_id: params.firmId,
      offered_by: params.actorUserId ?? null,
      offered_at: offeredAt,
      ...(params.acceptedAt ? { accepted_at: params.acceptedAt } : {}),
      expires_at: expiresAt,
    },
    {
      case_id: params.caseId,
      law_firm_org_id: params.firmId,
      offered_by: params.actorUserId ?? null,
      offered_at: offeredAt,
      ...(params.acceptedAt ? { accepted_at: params.acceptedAt } : {}),
      expires_at: expiresAt,
    },
  ]

  let lastError = ''
  for (const payload of variants) {
    const insertRes = await supabase
      .from('case_assignments')
      .insert(payload)
      .select('id')
      .maybeSingle<{ id: string }>()

    if (!insertRes.error && insertRes.data?.id) {
      return {
        ok: true as const,
        assignmentId: insertRes.data.id,
      }
    }

    const message = insertRes.error?.message || 'Could not create case assignment.'
    lastError = message

    if (insertRes.error && isCaseAssignmentCompatError(insertRes.error.message)) {
      continue
    }

    return {
      ok: false as const,
      error: message,
    }
  }

  return {
    ok: false as const,
    error: lastError || 'Could not create case assignment.',
  }
}

async function getReusableOpenQuote(params: {
  caseId: string
  firmId: string
  attorneyFeeCents: number
}) {
  const supabase = createServiceRoleClient()
  const existingQuote = await supabase
    .from('case_quotes')
    .select('id, law_firm_org_id, attorney_fee_cents, platform_fee_cents, total_cents, status')
    .eq('case_id', params.caseId)
    .in('status', ['OPEN', 'AWAITING_PAYMENT'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{
      id: string
      law_firm_org_id: string
      attorney_fee_cents: number
      platform_fee_cents: number
      total_cents: number
      status: string
    }>()

  if (existingQuote.error && !isMatchingInfrastructureError(existingQuote.error.message)) {
    return {
      ok: false as const,
      error: existingQuote.error.message,
    }
  }

  if (
    existingQuote.data?.id &&
    existingQuote.data.law_firm_org_id === params.firmId &&
    Number(existingQuote.data.attorney_fee_cents) === Number(params.attorneyFeeCents) &&
    Number(existingQuote.data.platform_fee_cents) === PLATFORM_FEE_CENTS
  ) {
    if (existingQuote.data.status !== 'AWAITING_PAYMENT') {
      const promote = await supabase
        .from('case_quotes')
        .update({ status: 'AWAITING_PAYMENT' })
        .eq('id', existingQuote.data.id)
      if (promote.error) {
        return {
          ok: false as const,
          error: promote.error.message,
        }
      }
    }

    return {
      ok: true as const,
      quoteId: existingQuote.data.id,
      totalCents: existingQuote.data.total_cents,
      reused: true,
    }
  }

  return {
    ok: true as const,
    quoteId: null,
    totalCents: 0,
    reused: false,
  }
}

async function assignCaseAndCreateQuote(params: {
  caseRow: CaseRow
  firmId: string
  attorneyFeeCents: number
  source: 'PRICING' | 'OUTREACH' | 'MANUAL'
  pricingAvailable: boolean
  outreachId?: string | null
  notes?: string | null
  quoteSourceAttorneyEmail?: string | null
  actorUserId?: string | null
}) {
  const supabase = createServiceRoleClient()

  if (!Number.isFinite(params.attorneyFeeCents) || params.attorneyFeeCents <= 0) {
    return {
      ok: false as const,
      error: 'Attorney fee must be greater than zero.',
    }
  }

  const membership = await supabase
    .from('attorney_firm_memberships')
    .select('user_id')
    .eq('firm_id', params.firmId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ user_id: string }>()

  const assignedAttorneyUserId = membership.data?.user_id ?? null

  const superseded = await supersedePendingMatchingArtifacts({
    caseId: params.caseRow.id,
    exceptFirmId: params.firmId,
    reason: `SUPERSEDED_BY_${params.source}`,
  })
  if (!superseded.ok) {
    return superseded
  }

  const caseUpdate = await updateCaseSafe(params.caseRow.id, {
    attorney_firm_id: params.source === 'PRICING' ? null : params.firmId,
    assigned_attorney_user_id: params.source === 'PRICING' ? null : assignedAttorneyUserId,
    pricing_available: params.pricingAvailable,
    attorney_fee_cents: params.attorneyFeeCents,
    platform_fee_cents: PLATFORM_FEE_CENTS,
    total_price_cents: params.attorneyFeeCents + PLATFORM_FEE_CENTS,
    quote_source_attorney_email: params.quoteSourceAttorneyEmail ?? null,
    updated_at: new Date().toISOString(),
  })
  if (!caseUpdate.ok) {
    return {
      ok: false as const,
      error: caseUpdate.error,
    }
  }

  const assignment =
    params.source === 'PRICING'
      ? {
          ok: true as const,
          assignmentId: null,
          reused: false,
        }
      : await ensureAcceptedCaseAssignment({
          caseId: params.caseRow.id,
          firmId: params.firmId,
          actorUserId: params.actorUserId ?? null,
        })
  if (!assignment.ok) {
    return assignment
  }

  const reusableQuote = await getReusableOpenQuote({
    caseId: params.caseRow.id,
    firmId: params.firmId,
    attorneyFeeCents: params.attorneyFeeCents,
  })
  if (!reusableQuote.ok) {
    return reusableQuote
  }

  if (reusableQuote.quoteId) {
    await setCaseStatus(params.caseRow.id, 'AWAITING_PAYMENT', 'QUOTE_REUSED', {
      source: params.source,
      quote_id: reusableQuote.quoteId,
      assignment_id: assignment.assignmentId,
    })

    return {
      ok: true as const,
      quoteId: reusableQuote.quoteId,
      totalCents: reusableQuote.totalCents,
      reused: true,
      assignmentId: assignment.assignmentId,
    }
  }

  const quoteVoid = await supabase
    .from('case_quotes')
    .update({ status: 'VOID' })
    .eq('case_id', params.caseRow.id)
    .in('status', ['OPEN', 'AWAITING_PAYMENT'])
  if (quoteVoid.error) {
    return {
      ok: false as const,
      error: quoteVoid.error.message,
    }
  }

  const quoteInsert = await insertCaseQuoteSafe({
    case_id: params.caseRow.id,
    law_firm_org_id: params.firmId,
    attorney_fee_cents: params.attorneyFeeCents,
    platform_fee_cents: PLATFORM_FEE_CENTS,
    status: 'AWAITING_PAYMENT',
    quote_source: params.source,
    outreach_id: params.outreachId ?? null,
    notes: params.notes ?? null,
    created_by: params.actorUserId ?? null,
  })
  if (!quoteInsert.ok || !quoteInsert.data?.id) {
    return {
      ok: false as const,
      error: quoteInsert.error || 'Could not create case quote.',
    }
  }

  await setCaseStatus(params.caseRow.id, 'AWAITING_PAYMENT', 'QUOTE_CREATED', {
    source: params.source,
    quote_id: quoteInsert.data.id,
    assignment_id: assignment.assignmentId,
  })

  try {
    await createCaseEvent({
      caseId: params.caseRow.id,
      actorId: params.actorUserId ?? null,
      type: 'QUOTE_READY',
      summary: `Quote ready (${params.source}) for $${((params.attorneyFeeCents + PLATFORM_FEE_CENTS) / 100).toFixed(2)}.`,
      metadata: {
        attorney_fee_cents: params.attorneyFeeCents,
        platform_fee_cents: PLATFORM_FEE_CENTS,
        total_cents: params.attorneyFeeCents + PLATFORM_FEE_CENTS,
        source: params.source,
        quote_id: quoteInsert.data.id,
      },
    })
  } catch (error) {
    console.error('Failed to create quote-ready case event:', error)
  }

  return {
    ok: true as const,
    quoteId: quoteInsert.data.id,
    totalCents: quoteInsert.data.total_cents ?? params.attorneyFeeCents + PLATFORM_FEE_CENTS,
    reused: false,
    assignmentId: assignment.assignmentId,
  }
}

async function getOutreachCandidates(caseRow: CaseRow) {
  const supabase = createServiceRoleClient()
  const state = normalizeState(caseRow.state)
  if (!state) return [] as DirectoryAttorney[]

  const directoryRes = await supabase
    .from('attorney_directory')
    .select('id, name, email, phone, state, address, lat, lng, is_statewide, counties')
    .eq('state', state)

  if (directoryRes.error || !directoryRes.data?.length) return []

  const county = normalizeCounty(caseRow.county)

  const countyQualified: DirectoryAttorney[] = []
  const unmatched: DirectoryAttorney[] = []
  const countyQualifiedEmails = new Set<string>()
  for (const row of directoryRes.data as DirectoryAttorney[]) {
    const emailKey = row.email.trim().toLowerCase()
    if (row.is_statewide) {
      countyQualified.push(row)
      if (emailKey) countyQualifiedEmails.add(emailKey)
      continue
    }

    const counties = parseJsonArray(row.counties).map((value) => String(value ?? '').trim())
    if (county && counties.some((coveredCounty) => countyNamesOverlap(coveredCounty, county))) {
      countyQualified.push(row)
      if (emailKey) countyQualifiedEmails.add(emailKey)
      continue
    }

    unmatched.push(row)
  }

  const dedupeByEmail = (candidates: DirectoryAttorney[]) => {
    const dedupedByEmail = new Map<string, DirectoryAttorney>()
    for (const candidate of candidates) {
      const key = candidate.email.trim().toLowerCase()
      if (!key) continue
      if (!dedupedByEmail.has(key)) dedupedByEmail.set(key, candidate)
      }
    return Array.from(dedupedByEmail.values())
  }

  if (!unmatched.length) {
    return dedupeByEmail(countyQualified)
  }

  const distanceByEmail = new Map<string, number>()
  const radiusQualified: DirectoryAttorney[] = []
  const routeMatrix = await computeDrivingDistanceMatrix({
    origin: {
      address: caseRow.court_address,
      lat: caseRow.court_lat,
      lng: caseRow.court_lng,
    },
    destinations: unmatched.map((row) => ({
      address: row.address,
      lat: row.lat,
      lng: row.lng,
    })),
  })

  if (routeMatrix.ok) {
    const routeCandidates = routeMatrix.results
      .filter((result) => result.ok && Number.isFinite(result.miles) && Number(result.miles) <= ATTORNEY_ROUTE_MATCH_MAX_MILES)
      .sort((left, right) => Number(left.miles) - Number(right.miles))
    for (const result of routeCandidates) {
      const candidate = unmatched[result.destinationIndex]
      if (!candidate) continue
      const emailKey = candidate.email.trim().toLowerCase()
      if (emailKey && !distanceByEmail.has(emailKey)) {
        distanceByEmail.set(emailKey, Number(result.miles))
      }
      radiusQualified.push(candidate)
    }
  }

  let courtLat = caseRow.court_lat
  let courtLng = caseRow.court_lng
  if ((!courtLat || !courtLng) && caseRow.court_address) {
    const geocode = await geocodeAddress(caseRow.court_address)
    if (geocode.ok && Number.isFinite(geocode.lat) && Number.isFinite(geocode.lng)) {
      courtLat = geocode.lat
      courtLng = geocode.lng
      await supabase
        .from('cases')
        .update({
          court_lat: geocode.lat,
          court_lng: geocode.lng,
          updated_at: new Date().toISOString(),
        })
        .eq('id', caseRow.id)
    }
  }

  for (const row of unmatched) {
    let lat = row.lat
    let lng = row.lng
    if ((!lat || !lng) && row.address) {
      const geocoded = await geocodeAddress(row.address)
      if (geocoded.ok && Number.isFinite(geocoded.lat) && Number.isFinite(geocoded.lng)) {
        lat = geocoded.lat
        lng = geocoded.lng
        await supabase
          .from('attorney_directory')
          .update({
            lat: geocoded.lat,
            lng: geocoded.lng,
            updated_at: new Date().toISOString(),
          })
          .eq('id', row.id)
      }
    }

    if (courtLat && courtLng && lat && lng) {
      const distance = milesBetween({ lat1: courtLat, lng1: courtLng, lat2: lat, lng2: lng })
      if (distance <= ATTORNEY_ROUTE_MATCH_MAX_MILES) {
        const emailKey = row.email.trim().toLowerCase()
        if (emailKey && !distanceByEmail.has(emailKey)) {
          distanceByEmail.set(emailKey, distance)
        }
        radiusQualified.push({ ...row, lat, lng })
      }
    }
  }

  const combined = dedupeByEmail([...countyQualified, ...radiusQualified])
  const ranked = await Promise.all(
    combined.map(async (candidate) => {
      const emailKey = candidate.email.trim().toLowerCase()
      const profile = await lookupAttorneyProfileByEmail(emailKey)
      return {
        candidate,
        emailKey,
        hasPlatformAccount: profile.hasPlatformAccount,
        countyQualified: countyQualifiedEmails.has(emailKey),
        distanceMiles: distanceByEmail.get(emailKey) ?? Number.POSITIVE_INFINITY,
      }
    })
  )

  return ranked
    .sort((left, right) => {
      if (left.hasPlatformAccount !== right.hasPlatformAccount) {
        return left.hasPlatformAccount ? -1 : 1
      }
      if (left.countyQualified !== right.countyQualified) {
        return left.countyQualified ? -1 : 1
      }
      if (left.distanceMiles !== right.distanceMiles) {
        return left.distanceMiles - right.distanceMiles
      }
      return left.candidate.email.localeCompare(right.candidate.email)
    })
    .map((row) => row.candidate)
}

function outreachHtml(params: {
  caseRow: CaseRow
  rawToken: string
  baseUrl: string
  outreachType: OutreachType
  documents: CaseDocumentLink[]
  dashboardUrl?: string | null
  inviteUrl?: string | null
  attorneyFeeCents?: number | null
}) {
  return buildAttorneyOutreachEmail(params).html
}

async function sendOutreachEmails(params: {
  caseRow: CaseRow
  candidates: DirectoryAttorney[]
}) {
  const supabase = createServiceRoleClient()
  const baseUrl = getBaseUrl()
  const nowIso = new Date().toISOString()
  const expiresIso = new Date(Date.now() + OUTREACH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()

  if (!baseUrl) {
    return {
      sentCount: 0,
      failures: ['Public app base URL is not configured for attorney outreach links.'],
    }
  }

  const documents = await loadCaseDocumentLinks(params.caseRow.id)
  const existing = await supabase
    .from('attorney_outreach')
    .select('email, status, outreach_type')
    .eq('case_id', params.caseRow.id)

  if (existing.error && isMatchingInfrastructureError(existing.error.message)) {
    return {
      sentCount: 0,
      failures: ['Attorney outreach tables are not ready yet.'],
      infraBlocked: true,
    }
  }

  const alreadySent = new Set<string>()
  for (const row of existing.data ?? []) {
    const status = String((row as { status?: string }).status ?? '').toUpperCase()
    const outreachType = String((row as { outreach_type?: string }).outreach_type ?? 'QUOTE_REQUEST').toUpperCase()
    if (outreachType === 'QUOTE_REQUEST' && ['PENDING', 'ACCEPTED', 'QUOTED'].includes(status)) {
      alreadySent.add(String((row as { email?: string }).email ?? '').trim().toLowerCase())
    }
  }

  let sentCount = 0
  const failures: string[] = []
  for (const candidate of params.candidates) {
    const email = candidate.email.trim().toLowerCase()
    if (!email || alreadySent.has(email)) continue

    const rawToken = createRawToken()
    const tokenHash = hashToken(rawToken)
    const account = await lookupAttorneyProfileByEmail(email)
    const inviteUrl = await buildAttorneyInviteLink(email)
    const dashboardUrl = account.hasPlatformAccount && baseUrl ? `${baseUrl}/attorney/dashboard` : null

    const insert = await supabase
      .from('attorney_outreach')
      .insert({
        case_id: params.caseRow.id,
        directory_attorney_id: candidate.id,
        law_firm_org_id: null,
        email,
        token_hash: tokenHash,
        token_expires_at: expiresIso,
        outreach_type: 'QUOTE_REQUEST',
        status: 'PENDING',
        sent_at: nowIso,
        metadata: {
          sent_at: nowIso,
        },
      })
      .select('id')
      .single<{ id: string }>()

    if (insert.error || !insert.data?.id) {
      if (insert.error?.message && isMatchingInfrastructureError(insert.error.message)) {
        return {
          sentCount,
          failures: ['Attorney outreach tables are not ready yet.'],
          infraBlocked: true,
        }
      }
      failures.push(insert.error?.message || `Could not record outreach for ${email}.`)
      continue
    }

    const emailBody = buildAttorneyOutreachEmail({
      caseRow: params.caseRow,
      rawToken,
      baseUrl,
      outreachType: 'QUOTE_REQUEST',
      documents,
      dashboardUrl,
      inviteUrl,
    })
    const subject = buildAttorneyOutreachSubject({
      caseRow: params.caseRow,
      outreachType: 'QUOTE_REQUEST',
    })
    const delivery = await sendEmail({
      to: [{ email, name: candidate.name ?? '' }],
      subject,
      html: emailBody.html,
      text: emailBody.text,
    })
    if (!delivery.ok) {
      failures.push(delivery.error)
      await supabase.from('attorney_outreach').delete().eq('id', insert.data.id)
      continue
    }

    if (account.attorneyUserId) {
      await createInAppCaseNotification({
        userId: account.attorneyUserId,
        caseId: params.caseRow.id,
        category: 'ATTORNEY_OUTREACH',
        title: 'New attorney quote request',
        body: `Review and respond to quote request ${params.caseRow.citation_number || params.caseRow.id}.`,
        href: `/attorney/respond/${encodeURIComponent(rawToken)}/accept`,
        metadata: {
          outreach_id: insert.data.id,
          outreach_type: 'QUOTE_REQUEST',
          case_reference: params.caseRow.citation_number || params.caseRow.id,
        },
      })
    }
    sentCount += 1
  }

  return { sentCount, failures, infraBlocked: false }
}

async function createPaymentRequestForQuote(params: {
  caseRow: CaseRow
  quoteId: string
  attorneyFeeCents: number
  totalCents: number
  sourceType: 'DIRECT_PRICED' | 'ATTORNEY_QUOTE' | 'MANUAL_MATCH'
  sendEmail: boolean
}) {
  const baseUrl = getBaseUrl()
  if (!baseUrl) {
    return { ok: false as const, error: 'Public app base URL is not configured for payment links.' }
  }

  const checkoutUrl = `${baseUrl}/checkout/${encodeURIComponent(params.quoteId)}`
  const primaryContact = getCasePrimaryContact(params.caseRow)
  const requestEmail = primaryContact.email || getCaseSubmitterEmail(params.caseRow) || ''
  const notification = buildSubmitterQuoteReadyEmail({
    caseRow: params.caseRow,
    checkoutUrl,
    attorneyFeeCents: params.attorneyFeeCents,
    totalCents: params.totalCents,
  })
  const paymentRequest = await upsertQuotePaymentRequest({
    caseId: params.caseRow.id,
    quoteId: params.quoteId,
    amountCents: params.totalCents,
    requestedByUserId: params.caseRow.submitter_user_id ?? params.caseRow.owner_id,
    requestedToUserId: params.caseRow.submitter_user_id ?? params.caseRow.owner_id,
    requestEmail,
    payerRole: primaryContact.role,
    sourceType: params.sourceType,
    checkoutUrl,
    note: params.sourceType === 'ATTORNEY_QUOTE' ? 'Attorney quote received and payment requested.' : 'Attorney pricing available.',
    notificationTitle:
      params.sourceType === 'ATTORNEY_QUOTE' ? 'Attorney quote ready for payment' : 'Attorney pricing ready for payment',
    notificationBody: `Pay ${formatUsd(params.totalCents)} for case ${params.caseRow.citation_number || params.caseRow.id}.`,
    notificationHref: `/cases/${params.caseRow.id}`,
    emailSubject: notification.subject,
    emailHtml: notification.html,
    emailText: notification.text,
    sendEmail: params.sendEmail,
    metadata: {
      attorney_fee_cents: params.attorneyFeeCents,
      platform_fee_cents: PLATFORM_FEE_CENTS,
      total_cents: params.totalCents,
      checkout_url: checkoutUrl,
    },
  })

  if (!paymentRequest.ok) {
    return paymentRequest
  }

  await updateCaseSafe(params.caseRow.id, {
    payment_request_sent_at: new Date().toISOString(),
    payment_flow_status: params.sourceType === 'ATTORNEY_QUOTE' ? 'PAYMENT_REQUEST_SENT' : 'DIRECT_PRICING_AVAILABLE',
    updated_at: new Date().toISOString(),
  })

  await createCaseEvent({
    caseId: params.caseRow.id,
    actorId: params.caseRow.submitter_user_id ?? params.caseRow.owner_id,
    type: 'PAYMENT_REQUEST_CREATED',
    summary:
      params.sourceType === 'ATTORNEY_QUOTE'
        ? 'Attorney quote received and payment request sent to submitter.'
        : 'Direct attorney pricing is ready for payment.',
    metadata: {
      quote_id: params.quoteId,
      payment_request_id: paymentRequest.paymentRequestId,
      source_type: params.sourceType,
      total_cents: params.totalCents,
    },
  })

  return {
    ok: true as const,
    checkoutUrl,
    paymentRequestId: paymentRequest.paymentRequestId,
  }
}

async function sendPricedMatchEmail(params: {
  caseRow: CaseRow
  firmId: string
  attorneyFeeCents: number
  quoteId: string
  submitterHasPaid?: boolean
}) {
  const baseUrl = getBaseUrl()
  if (!baseUrl) {
    return { ok: false as const, error: 'Public app base URL is not configured for attorney outreach links.' }
  }

  const contact = await loadFirmContact(params.firmId)
  if (!contact?.email) {
    return { ok: false as const, error: 'No attorney contact email is configured for the matched firm.' }
  }

  const supabase = createServiceRoleClient()
  const existing = await supabase
    .from('attorney_outreach')
    .select('id, status')
    .eq('case_id', params.caseRow.id)
    .eq('outreach_type', 'PRICED_MATCH')
    .eq('email', contact.email)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ id: string; status: string }>()

  const existingStatus = String(existing.data?.status ?? '').toUpperCase()
  if (!existing.error && existing.data?.id && ['PENDING', 'ACCEPTED', 'QUOTED'].includes(existingStatus)) {
    if (existingStatus === 'PENDING') {
      const assignment = await ensurePendingCaseAssignment({
        caseId: params.caseRow.id,
        firmId: params.firmId,
        actorUserId: contact.attorneyUserId ?? null,
      })
      if (!assignment.ok) {
        return {
          ok: false as const,
          error: assignment.error || 'Could not create pending case assignment for priced outreach.',
        }
      }

      if (contact.attorneyUserId) {
        await createInAppCaseNotification({
          userId: contact.attorneyUserId,
          caseId: params.caseRow.id,
          category: 'ATTORNEY_OUTREACH',
          title: params.submitterHasPaid ? 'Client paid and case is ready' : 'New priced assignment available',
          body: `Review and respond to ${params.caseRow.citation_number || params.caseRow.id}.`,
          href: '/attorney/dashboard?view=pending-acceptance',
          metadata: {
            outreach_id: existing.data.id,
            outreach_type: 'PRICED_MATCH',
            case_reference: params.caseRow.citation_number || params.caseRow.id,
          },
        })
      }
    }

    return { ok: true as const, skipped: true as const }
  }

  const rawToken = createRawToken()
  const tokenHash = hashToken(rawToken)
  const documents = await loadCaseDocumentLinks(params.caseRow.id)
  const inviteUrl =
    (await buildAttorneyInviteLink(contact.email)) ??
    (!contact.hasPlatformAccount ? `${baseUrl}/signup?email=${encodeURIComponent(contact.email)}` : null)
  const assignment = await ensurePendingCaseAssignment({
    caseId: params.caseRow.id,
    firmId: params.firmId,
    actorUserId: contact.attorneyUserId ?? null,
  })
  if (!assignment.ok) {
    return {
      ok: false as const,
      error: assignment.error || 'Could not create pending case assignment for priced outreach.',
    }
  }
  const sentAt = new Date().toISOString()
  const expiresIso = new Date(Date.now() + OUTREACH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString()
  const insert = await supabase
    .from('attorney_outreach')
    .insert({
      case_id: params.caseRow.id,
      law_firm_org_id: params.firmId,
      email: contact.email,
      token_hash: tokenHash,
      token_expires_at: expiresIso,
      outreach_type: 'PRICED_MATCH',
      status: 'PENDING',
      quoted_amount_cents: params.attorneyFeeCents,
      sent_at: sentAt,
      metadata: {
        quote_id: params.quoteId,
        sent_at: sentAt,
        source: 'PRICED_MATCH',
      },
    })
    .select('id')
    .single<{ id: string }>()

  if (insert.error || !insert.data?.id) {
    return { ok: false as const, error: insert.error?.message || 'Could not create priced attorney outreach.' }
  }

  const emailBody = buildAttorneyOutreachEmail({
    caseRow: params.caseRow,
    rawToken,
    baseUrl,
    outreachType: 'PRICED_MATCH',
    documents,
    dashboardUrl: contact.hasPlatformAccount ? `${baseUrl}/attorney/dashboard` : null,
    inviteUrl,
    attorneyFeeCents: params.attorneyFeeCents,
    submitterHasPaid: params.submitterHasPaid,
  })
  const delivery = await sendEmail({
    to: [{ email: contact.email, name: contact.contactName }],
    subject: buildAttorneyOutreachSubject({
      caseRow: params.caseRow,
      outreachType: 'PRICED_MATCH',
      submitterHasPaid: params.submitterHasPaid,
    }),
    html: emailBody.html,
    text: emailBody.text,
  })

  if (!delivery.ok) {
    await supabase.from('attorney_outreach').delete().eq('id', insert.data.id)
    return { ok: false as const, error: delivery.error }
  }

  if (contact.attorneyUserId) {
    await createInAppCaseNotification({
      userId: contact.attorneyUserId,
      caseId: params.caseRow.id,
      category: 'ATTORNEY_OUTREACH',
      title: params.submitterHasPaid ? 'Client paid and case is ready' : 'New priced assignment available',
      body: `Review and respond to ${params.caseRow.citation_number || params.caseRow.id}.`,
      href: '/attorney/dashboard?view=pending-acceptance',
      metadata: {
        outreach_id: insert.data.id,
        assignment_id: assignment.assignmentId,
        outreach_type: 'PRICED_MATCH',
        case_reference: params.caseRow.citation_number || params.caseRow.id,
      },
    })
  }

  await createCaseEvent({
    caseId: params.caseRow.id,
    actorId: contact.attorneyUserId,
    type: 'PRICED_MATCH_SENT',
    summary: 'Paid case email sent to matched attorney.',
    metadata: {
      quote_id: params.quoteId,
      outreach_id: insert.data.id,
      firm_id: params.firmId,
      attorney_email: contact.email,
    },
  })

  return {
    ok: true as const,
    outreachId: insert.data.id,
  }
}

export async function handleQuotePaymentCompletion(params: { quoteId: string; caseId: string }) {
  const supabase = createServiceRoleClient()
  const quoteRes = await supabase
    .from('case_quotes')
    .select('id, case_id, law_firm_org_id, attorney_fee_cents, total_cents, quote_source, outreach_id')
    .eq('id', params.quoteId)
    .maybeSingle<{
      id: string
      case_id: string
      law_firm_org_id: string
      attorney_fee_cents: number
      total_cents: number
      quote_source: string
      outreach_id: string | null
    }>()

  if (quoteRes.error || !quoteRes.data) {
    return { ok: false as const, error: quoteRes.error?.message || 'Quote not found for payment completion.' }
  }

  const caseRes = await fetchCaseRow(params.caseId)
  if (!caseRes.data) {
    return { ok: false as const, error: caseRes.error || 'Case not found for payment completion.' }
  }

  const caseRow = caseRes.data
  const quoteSource = String(quoteRes.data.quote_source ?? '').trim().toUpperCase()
  await markQuotePaymentRequestPaid({
    quoteId: params.quoteId,
    caseId: params.caseId,
    provider: 'LAWPAY',
    metadata: {
      quote_id: params.quoteId,
      case_id: params.caseId,
    },
  })

  await createInAppCaseNotification({
    userId: caseRow.submitter_user_id ?? caseRow.owner_id,
    caseId: caseRow.id,
    category: 'PAYMENT',
    title: 'Payment received',
    body: `We received ${formatUsd(quoteRes.data.total_cents)} for case ${caseRow.citation_number || caseRow.id}.`,
    href: `/cases/${caseRow.id}`,
    metadata: {
      quote_id: params.quoteId,
      source: quoteSource,
    },
  })

  if (quoteSource === 'OUTREACH') {
    await setCaseStatus(caseRow.id, 'IN_PROGRESS', 'ATTORNEY_QUOTE_PAID', {
      quote_id: params.quoteId,
    })
    await updateCaseSafe(caseRow.id, {
      payment_flow_status: 'ATTORNEY_ASSIGNED',
      updated_at: new Date().toISOString(),
    })

    const attorneyEmail = caseRow.quote_source_attorney_email || String(caseRow.metadata?.['quote_source_attorney_email'] ?? '').trim()
    const baseUrl = getBaseUrl()
    if (attorneyEmail) {
      await sendEmail({
        to: [{ email: attorneyEmail }],
        subject: 'Payment received for your CDL Protect case',
        html: baseUrl
          ? `<p>Payment was received and the case is now active.</p><p><a href="${baseUrl}/attorney/dashboard">Open Attorney Dashboard</a></p>`
          : '<p>Payment was received and the case is now active.</p>',
        text: baseUrl
          ? `Payment was received and the case is now active. Dashboard: ${baseUrl}/attorney/dashboard`
          : 'Payment was received and the case is now active.',
      })
    }

    await createCaseEvent({
      caseId: caseRow.id,
      actorId: caseRow.submitter_user_id ?? caseRow.owner_id,
      type: 'ATTORNEY_ASSIGNED',
      summary: 'Submitter payment completed and quoting attorney is confirmed.',
      metadata: {
        quote_id: params.quoteId,
        quote_source: quoteSource,
      },
    })

    return { ok: true as const, mode: 'OUTREACH' as const }
  }

  const pricedEmail = await sendPricedMatchEmail({
    caseRow,
    firmId: quoteRes.data.law_firm_org_id,
    attorneyFeeCents: Number(quoteRes.data.attorney_fee_cents),
    quoteId: params.quoteId,
    submitterHasPaid: true,
  })

  if (pricedEmail.ok) {
    await setCaseStatus(caseRow.id, 'OFFERED_TO_ATTORNEY', 'PRICED_MATCH_SENT', {
      quote_id: params.quoteId,
      law_firm_org_id: quoteRes.data.law_firm_org_id,
    })
  } else {
    await createCaseEvent({
      caseId: caseRow.id,
      actorId: caseRow.submitter_user_id ?? caseRow.owner_id,
      type: 'PRICED_MATCH_EMAIL_FAILED',
      summary: 'Direct priced attorney outreach could not be delivered after payment.',
      metadata: {
        quote_id: params.quoteId,
        law_firm_org_id: quoteRes.data.law_firm_org_id,
        error: pricedEmail.error,
      },
    })
  }

  await updateCaseSafe(caseRow.id, {
    payment_flow_status: pricedEmail.ok ? 'ATTORNEY_REVIEW_PENDING' : 'PAYMENT_COMPLETED',
    updated_at: new Date().toISOString(),
  })

  return {
    ok: true as const,
    mode: 'PRICING' as const,
    attorneyNotified: pricedEmail.ok,
  }
}

export async function runAttorneyMatchingForCase(params: { caseId: string; actorUserId?: string | null }) {
  try {
    const caseRes = await fetchCaseRow(params.caseId)
    if (!caseRes.data) {
      return {
        ok: false as const,
        mode: 'OUTREACH_NONE' as MatchingMode,
        message: caseRes.error || 'Case not found.',
      }
    }

    const caseRow = caseRes.data
    let coverageSyncErrors: string[] = []

    try {
      const syncResult = await syncAttorneyMatchingCoverageForJurisdiction({
        state: caseRow.state,
        county: caseRow.county,
      })
      coverageSyncErrors = syncResult.errors
    } catch (error) {
      console.error('Attorney coverage sync before matching failed:', error)
      coverageSyncErrors = [error instanceof Error ? error.message : 'Attorney coverage sync failed.']
    }

    const pricing = await pricingAvailable(caseRow)
    if (pricing) {
      const quote = await assignCaseAndCreateQuote({
        caseRow,
        firmId: pricing.firmId,
        attorneyFeeCents: pricing.attorneyFeeCents,
        source: 'PRICING',
        pricingAvailable: true,
        actorUserId: params.actorUserId ?? null,
      })
      if (!quote.ok) {
        if (isMatchingInfrastructureError(quote.error)) {
          return {
            ok: true as const,
            mode: 'OUTREACH_NONE' as MatchingMode,
            message: 'Attorney matching is temporarily unavailable.',
          }
        }
        return {
          ok: false as const,
          mode: 'OUTREACH_NONE' as MatchingMode,
          message: quote.error,
        }
      }

      await updateCaseSafe(caseRow.id, {
        pricing_available: true,
        attorney_fee_cents: pricing.attorneyFeeCents,
        platform_fee_cents: PLATFORM_FEE_CENTS,
        total_price_cents: pricing.attorneyFeeCents + PLATFORM_FEE_CENTS,
        payment_flow_status: 'DIRECT_PRICING_AVAILABLE',
        updated_at: new Date().toISOString(),
      })

      const paymentRequest = await createPaymentRequestForQuote({
        caseRow,
        quoteId: quote.quoteId,
        attorneyFeeCents: pricing.attorneyFeeCents,
        totalCents: pricing.attorneyFeeCents + PLATFORM_FEE_CENTS,
        sourceType: 'DIRECT_PRICED',
        sendEmail: false,
      })
      if (!paymentRequest.ok) {
        return {
          ok: false as const,
          mode: 'OUTREACH_NONE' as MatchingMode,
          message: paymentRequest.error,
        }
      }

      return {
        ok: true as const,
        mode: 'PRICING_AVAILABLE' as MatchingMode,
        quoteId: quote.quoteId,
        message: quote.reused
          ? 'Existing quote is still valid for checkout.'
          : 'Pricing found. Quote is ready for checkout.',
      }
    }

    await updateCaseSafe(caseRow.id, {
      pricing_available: false,
      attorney_fee_cents: null,
      platform_fee_cents: null,
      total_price_cents: null,
      quote_requested_at: new Date().toISOString(),
      attorney_outreach_started_at: new Date().toISOString(),
      payment_flow_status: 'AWAITING_ATTORNEY_QUOTES',
      updated_at: new Date().toISOString(),
    })

    await setCaseStatus(caseRow.id, 'ATTORNEY_MATCHING', 'ATTORNEY_OUTREACH_STARTED')

    const candidates = await getOutreachCandidates(caseRow)
    if (!candidates.length) {
      await createCaseEvent({
        caseId: caseRow.id,
        actorId: params.actorUserId ?? null,
        type: 'OUTREACH_NONE',
        summary: 'No outreach candidates found for this jurisdiction.',
        metadata: {
          state: caseRow.state,
          county: caseRow.county,
          coverage_sync_errors: coverageSyncErrors.slice(0, 3),
        },
      })

      return {
        ok: true as const,
        mode: 'OUTREACH_NONE' as MatchingMode,
        message: coverageSyncErrors.length
          ? 'No candidates were matched. Attorney coverage sync reported issues.'
          : 'No local outreach candidates were found.',
      }
    }

    const outreach = await sendOutreachEmails({
      caseRow,
      candidates,
    })

    await createCaseEvent({
      caseId: caseRow.id,
      actorId: params.actorUserId ?? null,
      type: 'OUTREACH_SENT',
      summary:
        outreach.sentCount > 0
          ? `Outreach sent to ${outreach.sentCount} attorney${outreach.sentCount === 1 ? '' : 's'}.`
          : 'Outreach could not be delivered.',
      metadata: {
        sent_count: outreach.sentCount,
        failures: outreach.failures.slice(0, 5),
      },
    })
    if (!outreach.sentCount) {
      if (outreach.infraBlocked) {
        return {
          ok: true as const,
          mode: 'OUTREACH_NONE' as MatchingMode,
          message: 'Attorney matching is temporarily unavailable.',
        }
      }
      return {
        ok: false as const,
        mode: 'OUTREACH_NONE' as MatchingMode,
        message: outreach.failures[0] || 'No outreach emails could be delivered.',
      }
    }

    await setCaseStatus(caseRow.id, 'OFFERED_TO_ATTORNEY', 'ATTORNEY_OUTREACH_SENT', {
      sent_count: outreach.sentCount,
    })
    await updateCaseSafe(caseRow.id, {
      payment_flow_status: 'AWAITING_ATTORNEY_QUOTES',
      updated_at: new Date().toISOString(),
    })

    return {
      ok: true as const,
      mode: 'OUTREACH_SENT' as MatchingMode,
      message:
        outreach.failures.length > 0
          ? `Outreach sent to ${outreach.sentCount} attorney${outreach.sentCount === 1 ? '' : 's'}; some deliveries failed.`
          : `Outreach sent to ${outreach.sentCount} attorney${outreach.sentCount === 1 ? '' : 's'}.`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Attorney matching failed.'
    if (isMatchingInfrastructureError(message)) {
      return {
        ok: true as const,
        mode: 'OUTREACH_NONE' as MatchingMode,
        message: 'Attorney matching is temporarily unavailable.',
      }
    }

    return {
      ok: false as const,
      mode: 'OUTREACH_NONE' as MatchingMode,
      message,
    }
  }
}

export async function createManualAttorneyMatchForCase(params: {
  caseId: string
  firmId: string
  attorneyFeeCents: number
  actorUserId?: string | null
}) {
  const caseRes = await fetchCaseRow(params.caseId)
  if (!caseRes.data) {
    return {
      ok: false as const,
      message: caseRes.error || 'Case not found.',
    }
  }

  const quote = await assignCaseAndCreateQuote({
    caseRow: caseRes.data,
    firmId: params.firmId,
    attorneyFeeCents: params.attorneyFeeCents,
    source: 'MANUAL',
    pricingAvailable: true,
    actorUserId: params.actorUserId ?? null,
  })

  if (!quote.ok) {
    return {
      ok: false as const,
      message: quote.error,
    }
  }

  try {
    await createPaymentRequestForQuote({
      caseRow: caseRes.data,
      quoteId: quote.quoteId,
      attorneyFeeCents: params.attorneyFeeCents,
      totalCents: quote.totalCents,
      sourceType: 'MANUAL_MATCH',
      sendEmail: false,
    })
    await createCaseEvent({
      caseId: params.caseId,
      actorId: params.actorUserId ?? null,
      type: 'MANUAL_ATTORNEY_MATCH',
      summary: quote.reused
        ? 'Admin reused the existing attorney quote for this case.'
        : 'Admin created a manual attorney match and quote.',
      metadata: {
        firm_id: params.firmId,
        attorney_fee_cents: params.attorneyFeeCents,
        quote_id: quote.quoteId,
        assignment_id: quote.assignmentId,
        reused_quote: quote.reused,
      },
    })
  } catch (error) {
    console.error('Failed to create manual attorney match event:', error)
  }

  return {
    ok: true as const,
    quoteId: quote.quoteId,
    reused: quote.reused,
    message: quote.reused
      ? 'Existing quote is still active. Pending outreach and offers were superseded.'
      : 'Manual attorney match created successfully.',
  }
}

async function ensureFirmAndUserFromOutreach(params: {
  outreachId: string
  directoryAttorneyId: string | null
  email: string
  caseRow: CaseRow
}) {
  const supabase = createServiceRoleClient()

  let directory: DirectoryAttorney | null = null
  if (params.directoryAttorneyId) {
    const directoryRes = await supabase
      .from('attorney_directory')
      .select('id, name, email, phone, state, address, lat, lng, is_statewide, counties')
      .eq('id', params.directoryAttorneyId)
      .maybeSingle<DirectoryAttorney>()
    directory = directoryRes.data ?? null
  }

  const normalizedEmail = params.email.trim().toLowerCase()

  const existingFirm = await supabase
    .from('attorney_firms')
    .select('id')
    .eq('email', normalizedEmail)
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (existingFirm.error && !isMatchingInfrastructureError(existingFirm.error.message)) {
    throw new Error(existingFirm.error.message)
  }

  let firmId = existingFirm.data?.id ?? ''
  if (!firmId) {
    const firmCreate = await supabase
      .from('attorney_firms')
      .insert({
        company_name: (directory?.name || normalizedEmail).slice(0, 120),
        contact_name: directory?.name ?? null,
        email: normalizedEmail,
        phone: directory?.phone ?? null,
        state: params.caseRow.state ?? directory?.state ?? null,
        office_address: directory?.address ?? null,
        coverage_states: params.caseRow.state ? [params.caseRow.state] : [],
        primary_county: params.caseRow.county ?? null,
        counties: params.caseRow.county ? [params.caseRow.county] : [],
      })
      .select('id')
      .single<{ id: string }>()

    if (firmCreate.error || !firmCreate.data?.id) {
      throw new Error(firmCreate.error?.message || 'Could not create attorney firm from outreach.')
    }

    firmId = firmCreate.data?.id ?? ''
  }

  const profile = await supabase
    .from('profiles')
    .select('id, user_id')
    .ilike('email', normalizedEmail)
    .limit(1)
    .maybeSingle<{ id: string; user_id: string | null }>()

  const attorneyUserId = profile.data?.user_id || profile.data?.id || null
  let inviteLink: string | null = null

  if (attorneyUserId) {
    await supabase.from('attorney_firm_memberships').upsert(
      {
        firm_id: firmId,
        user_id: attorneyUserId,
        role_in_firm: 'attorney_admin',
      },
      { onConflict: 'firm_id,user_id' }
    )
  } else {
    const baseUrl = getBaseUrl()
    const invite = await supabase.auth.admin.generateLink({
      type: 'invite',
      email: normalizedEmail,
      options: baseUrl
        ? {
            redirectTo: `${baseUrl}/auth/confirm?next=/attorney/dashboard&set_password=1`,
          }
        : undefined,
    })

    inviteLink = invite.data?.properties?.action_link ?? null

    await sendEmail({
      to: [{ email: normalizedEmail, name: directory?.name ?? '' }],
      subject: 'Attorney account invitation - CDL Protect',
      html: inviteLink
        ? `<p>You accepted a case on CDL Protect.</p><p>Complete your account setup here: <a href="${inviteLink}">${inviteLink}</a></p>`
        : '<p>You accepted a case on CDL Protect. Contact support to finish account setup.</p>',
      text: inviteLink
        ? `You accepted a case on CDL Protect. Complete your account setup: ${inviteLink}`
        : 'You accepted a case on CDL Protect. Contact support to finish account setup.',
    })
  }

  return {
    firmId,
    attorneyUserId,
    inviteLink,
    attorneyName: directory?.name ?? normalizedEmail,
  }
}

async function loadOutreachByToken(rawToken: string, options?: { allowHandled?: boolean }) {
  const supabase = createServiceRoleClient()
  const tokenHash = hashToken(rawToken)

  const outreach = await supabase
    .from('attorney_outreach')
    .select(
      'id, case_id, law_firm_org_id, directory_attorney_id, email, outreach_type, token_expires_at, status, accepted_at, quoted_at, quoted_amount_cents, attorney_notes'
    )
    .eq('token_hash', tokenHash)
    .limit(1)
    .maybeSingle<OutreachRow>()

  if (outreach.error || !outreach.data) {
    return { error: 'Link expired or already responded.' }
  }

  const now = Date.now()
  const expires = new Date(outreach.data.token_expires_at).getTime()
  const status = String(outreach.data.status ?? '').toUpperCase()
  const handled = ['DECLINED', 'EXPIRED', 'SUPERSEDED', 'QUOTED'].includes(status)
  const pricedAccepted = outreach.data.outreach_type === 'PRICED_MATCH' && status === 'ACCEPTED'

  if (!Number.isFinite(expires) || now > expires || ((!options?.allowHandled && handled) || (!options?.allowHandled && pricedAccepted))) {
    return { error: 'Link expired or already responded.', outreachId: outreach.data.id, caseId: outreach.data.case_id }
  }

  return {
    outreach: outreach.data,
    handled: handled || pricedAccepted,
  }
}

export async function getOutreachTokenSummary(rawToken: string) {
  const lookup = await loadOutreachByToken(rawToken, { allowHandled: true })
  if ('error' in lookup) return { ok: false as const, error: lookup.error }

  const caseRes = await fetchCaseRow(lookup.outreach.case_id)
  if (!caseRes.data) {
    return { ok: false as const, error: 'Case not found for this outreach link.' }
  }

  return {
    ok: true as const,
    caseSummary: caseRes.data,
    documents: await loadCaseDocumentLinks(lookup.outreach.case_id),
    outreach: lookup.outreach,
    handled: lookup.handled,
  }
}

export async function submitOutreachQuote(params: {
  rawToken: string
  feeCents: number
  notes?: string | null
  responseIp?: string
  userAgent?: string
}) {
  const lookup = await loadOutreachByToken(params.rawToken)
  if ('error' in lookup) {
    return { ok: false as const, error: lookup.error }
  }

  if (!Number.isFinite(params.feeCents) || params.feeCents <= 0) {
    return { ok: false as const, error: 'Fee amount must be greater than zero.' }
  }

  if (lookup.outreach.outreach_type !== 'QUOTE_REQUEST') {
    return { ok: false as const, error: 'This secure link is for a priced assignment.' }
  }

  const supabase = createServiceRoleClient()
  const acceptedExists = await supabase
    .from('attorney_outreach')
    .select('id')
    .eq('case_id', lookup.outreach.case_id)
    .eq('outreach_type', 'QUOTE_REQUEST')
    .in('status', ['ACCEPTED', 'QUOTED'])
    .neq('id', lookup.outreach.id)
    .limit(1)
    .maybeSingle<{ id: string }>()

  if (acceptedExists.data?.id) {
    return { ok: false as const, error: 'Another attorney already responded for this case.' }
  }

  const caseRes = await fetchCaseRow(lookup.outreach.case_id)
  if (!caseRes.data) {
    return { ok: false as const, error: 'Case not found.' }
  }

  const caseRow = caseRes.data
  const noteText = String(params.notes ?? '').trim() || null
  const responseAt = new Date().toISOString()
  const acceptUpdate = await supabase
    .from('attorney_outreach')
    .update({
      status: 'QUOTED',
      accepted_at: responseAt,
      quoted_at: responseAt,
      quoted_amount_cents: params.feeCents,
      attorney_notes: noteText,
      responded_at: responseAt,
      response_ip: params.responseIp ?? null,
      response_user_agent: params.userAgent ?? null,
    })
    .eq('id', lookup.outreach.id)
    .eq('status', 'PENDING')
    .select('id')
    .maybeSingle<{ id: string }>()
  if (acceptUpdate.error || !acceptUpdate.data) {
    return { ok: false as const, error: 'Link expired or already responded.' }
  }

  await supabase
    .from('attorney_outreach')
    .update({
      status: 'SUPERSEDED',
      responded_at: responseAt,
    })
    .eq('case_id', lookup.outreach.case_id)
    .eq('status', 'PENDING')
    .eq('outreach_type', 'QUOTE_REQUEST')
    .neq('id', lookup.outreach.id)

  const ensured = await ensureFirmAndUserFromOutreach({
    outreachId: lookup.outreach.id,
    directoryAttorneyId: lookup.outreach.directory_attorney_id,
    email: lookup.outreach.email,
    caseRow,
  })

  const quote = await assignCaseAndCreateQuote({
    caseRow,
    firmId: ensured.firmId,
    attorneyFeeCents: params.feeCents,
    source: 'OUTREACH',
    pricingAvailable: false,
    outreachId: lookup.outreach.id,
    notes: noteText,
    quoteSourceAttorneyEmail: lookup.outreach.email,
    actorUserId: ensured.attorneyUserId,
  })
  if (!quote.ok) {
    return { ok: false as const, error: quote.error }
  }

  const state = normalizeState(caseRow.state)
  const county = normalizeCounty(caseRow.county)
  if (state && county) {
    await supabase.from('attorney_pricing').upsert(
      {
        law_firm_org_id: ensured.firmId,
        state,
        county,
        cdl_fee_cents: params.feeCents,
        non_cdl_fee_cents: params.feeCents,
        is_active: true,
        source: 'OUTREACH_ACCEPT',
        updated_by: ensured.attorneyUserId,
      },
      { onConflict: 'law_firm_org_id,state,county' }
    )
  }

  const paymentRequest = await createPaymentRequestForQuote({
    caseRow,
    quoteId: quote.quoteId,
    attorneyFeeCents: params.feeCents,
    totalCents: quote.totalCents,
    sourceType: 'ATTORNEY_QUOTE',
    sendEmail: true,
  })
  if (!paymentRequest.ok) {
    return { ok: false as const, error: paymentRequest.error }
  }

  await updateCaseSafe(caseRow.id, {
    quote_received_at: responseAt,
    payment_flow_status: 'PAYMENT_REQUEST_SENT',
    updated_at: responseAt,
  })

  await createCaseEvent({
    caseId: caseRow.id,
    actorId: ensured.attorneyUserId,
    type: 'OUTREACH_ACCEPTED',
    summary: 'Attorney accepted the quote request and submitted a fee.',
    metadata: {
      outreach_id: lookup.outreach.id,
      fee_cents: params.feeCents,
      quote_id: quote.quoteId,
      firm_id: ensured.firmId,
      attorney_notes: noteText,
      payment_request_id: paymentRequest.paymentRequestId,
    },
  })

  const baseUrl = getBaseUrl()
  await sendEmail({
    to: [{ email: lookup.outreach.email, name: ensured.attorneyName }],
    subject: 'Your attorney quote was submitted',
    html: baseUrl
      ? `<p>Your quote was received. We will notify you when payment is completed.</p><p><a href="${baseUrl}/attorney/dashboard">Open Attorney Dashboard</a></p>`
      : '<p>Your quote was received. We will notify you when payment is completed.</p>',
    text: baseUrl
      ? `Your quote was received. Dashboard: ${baseUrl}/attorney/dashboard`
      : 'Your quote was received. We will notify you when payment is completed.',
  })

  return {
    ok: true as const,
    caseId: caseRow.id,
    quoteId: quote.quoteId,
  }
}

export async function acceptPricedOutreach(params: { rawToken: string; responseIp?: string; userAgent?: string }) {
  const lookup = await loadOutreachByToken(params.rawToken)
  if ('error' in lookup) {
    return { ok: false as const, error: lookup.error }
  }

  if (lookup.outreach.outreach_type !== 'PRICED_MATCH') {
    return { ok: false as const, error: 'This secure link is for a quote submission, not a priced assignment.' }
  }

  const supabase = createServiceRoleClient()
  const responseAt = new Date().toISOString()
  const firmId = String(lookup.outreach.law_firm_org_id ?? '').trim()
  if (!firmId) {
    return { ok: false as const, error: 'Matched firm is missing for this outreach.' }
  }

  const acceptUpdate = await supabase
    .from('attorney_outreach')
    .update({
      status: 'ACCEPTED',
      accepted_at: responseAt,
      responded_at: responseAt,
      response_ip: params.responseIp ?? null,
      response_user_agent: params.userAgent ?? null,
    })
    .eq('id', lookup.outreach.id)
    .eq('status', 'PENDING')
    .select('id')
    .maybeSingle<{ id: string }>()

  if (acceptUpdate.error || !acceptUpdate.data) {
    return { ok: false as const, error: 'Link expired or already responded.' }
  }

  const firmContact = await loadFirmContact(firmId)
  const acceptedAssignment = await ensureAcceptedCaseAssignment({
    caseId: lookup.outreach.case_id,
    firmId,
    actorUserId: firmContact?.attorneyUserId ?? null,
  })
  if (!acceptedAssignment.ok) {
    return { ok: false as const, error: acceptedAssignment.error || 'Could not confirm the case assignment.' }
  }

  await createCaseEvent({
    caseId: lookup.outreach.case_id,
    type: 'PRICED_MATCH_ACCEPTED',
    summary: 'Matched attorney accepted the paid assignment.',
    metadata: {
      outreach_id: lookup.outreach.id,
      law_firm_org_id: firmId,
      assignment_id: acceptedAssignment.assignmentId,
      attorney_email: lookup.outreach.email,
    },
  })

  await setCaseStatus(lookup.outreach.case_id, 'IN_PROGRESS', 'PRICED_MATCH_ACCEPTED', {
    outreach_id: lookup.outreach.id,
    assignment_id: acceptedAssignment.assignmentId,
  })
  await updateCaseSafe(lookup.outreach.case_id, {
    attorney_firm_id: firmId,
    assigned_attorney_user_id: firmContact?.attorneyUserId ?? null,
    payment_flow_status: 'ATTORNEY_ASSIGNED',
    quote_source_attorney_email: lookup.outreach.email,
    updated_at: responseAt,
  })

  return {
    ok: true as const,
    caseId: lookup.outreach.case_id,
  }
}

export async function denyOutreach(params: { rawToken: string; reason: string; responseIp?: string; userAgent?: string }) {
  const lookup = await loadOutreachByToken(params.rawToken)
  if ('error' in lookup) {
    return { ok: false as const, error: lookup.error }
  }

  const reason = String(params.reason ?? '').trim()
  if (!reason) {
    return { ok: false as const, error: 'Please provide a reason for decline.' }
  }

  const supabase = createServiceRoleClient()

  const denyUpdate = await supabase
    .from('attorney_outreach')
    .update({
      status: 'DECLINED',
      deny_reason: reason,
      responded_at: new Date().toISOString(),
      response_ip: params.responseIp ?? null,
      response_user_agent: params.userAgent ?? null,
    })
    .eq('id', lookup.outreach.id)
    .eq('status', 'PENDING')
    .select('id')
    .maybeSingle<{ id: string }>()
  if (denyUpdate.error || !denyUpdate.data) {
    return { ok: false as const, error: 'Link expired or already responded.' }
  }

  await createCaseEvent({
    caseId: lookup.outreach.case_id,
    type: lookup.outreach.outreach_type === 'PRICED_MATCH' ? 'PRICED_MATCH_DECLINED' : 'OUTREACH_DECLINED',
    summary:
      lookup.outreach.outreach_type === 'PRICED_MATCH'
        ? 'Matched attorney declined the paid assignment.'
        : 'Attorney declined quote request outreach.',
    metadata: {
      outreach_id: lookup.outreach.id,
      deny_reason: reason,
      email: lookup.outreach.email,
      outreach_type: lookup.outreach.outreach_type,
    },
  })

  if (lookup.outreach.outreach_type === 'PRICED_MATCH') {
    await updateCaseSafe(lookup.outreach.case_id, {
      payment_flow_status: 'ATTORNEY_DECLINED',
      updated_at: new Date().toISOString(),
    })
  }

  const supportEmail = String(process.env.CDL_SUPPORT_EMAIL ?? '').trim()
  if (supportEmail) {
    await sendEmail({
      to: [{ email: supportEmail }],
      subject: `Attorney declined outreach for case ${lookup.outreach.case_id}`,
      html: `<p>Attorney ${lookup.outreach.email} declined outreach.</p><p>Reason: ${reason}</p>`,
      text: `Attorney ${lookup.outreach.email} declined outreach. Reason: ${reason}`,
    })
  }

  return {
    ok: true as const,
    caseId: lookup.outreach.case_id,
  }
}

export async function markOutreachExpiredByToken(rawToken: string) {
  const supabase = createServiceRoleClient()
  const tokenHash = hashToken(rawToken)
  await supabase
    .from('attorney_outreach')
    .update({
      status: 'EXPIRED',
      responded_at: new Date().toISOString(),
    })
    .eq('token_hash', tokenHash)
    .eq('status', 'PENDING')
}
