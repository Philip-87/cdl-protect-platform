import type { SupabaseClient } from '@supabase/supabase-js'
import { getAccessibleFleetIds } from '@/app/lib/server/fleet-access'
import { createClient } from '@/app/lib/supabase/server'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'
import {
  hashBrowserFile,
  type OcrPreviewTokenPayload,
  verifyOcrPreviewToken,
} from '@/app/lib/server/ocr-preview-token'
import { buildTicketOcrText, runTicketOcrFromPublicUrl } from '@/app/lib/server/ocr'
import { enqueueDocumentOcrJob } from '@/app/lib/server/job-queue'
import { isAttorneyRole, isDriverRole, normalizePlatformRole } from '@/app/lib/roles'
import { runAttorneyMatchingForCase } from '@/app/lib/matching/attorneyMatching'

const MAX_UPLOAD_BYTES = 12 * 1024 * 1024
const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6
const SYNC_OCR_ON_SUBMIT =
  String(process.env.INTAKE_SYNC_OCR_ON_SUBMIT ?? '').trim() === '1' ||
  String(process.env.OCR_SYNC_FALLBACK_ON_UPLOAD ?? '').trim() === '1'

type QueryClient = Pick<SupabaseClient, 'from'>

type CaseInsertContext = {
  userId: string
  email: string
  firstName: string
  lastName: string
  allowCreate?: boolean
}

function yesNo(value: FormDataEntryValue | null) {
  return String(value ?? '').trim() || 'No'
}

function clean(value: FormDataEntryValue | null) {
  return String(value ?? '').trim()
}

function cleanFileName(fileName: string) {
  return fileName.replace(/[^a-zA-Z0-9._-]/g, '_')
}

function parseDateToYmd(input: string) {
  const s = String(input || '').trim()
  if (!s) return null

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
  if (mdy.test(s)) {
    const [, mm, dd, yy] = s.match(mdy) ?? []
    const year = yy.length === 2 ? `20${yy}` : yy
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  }

  const d = new Date(s)
  if (!Number.isNaN(+d)) {
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }

  return null
}

function buildNotes(payload: Record<string, string>) {
  const parts = [
    payload.notes ? `Notes: ${payload.notes}` : '',
    `Did Receive Ticket: ${payload.did_receive_ticket || 'No'}`,
    `Accident: ${payload.accident || 'No'}`,
    `CDL Driver: ${payload.cdl_driver || 'No'}`,
    `Commercial Vehicle: ${payload.while_driving_commercial_vehicle || 'No'}`,
    payload.broker_name ? `Broker: ${payload.broker_name}` : '',
    payload.broker_email ? `Broker Email: ${payload.broker_email}` : '',
  ].filter(Boolean)

  return parts.join(' | ')
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

function isDriverConstraintError(message: string) {
  return (
    /driver_id/i.test(message) &&
    (/violates not-null constraint/i.test(message) ||
      /foreign key constraint/i.test(message) ||
      /cases_driver_id_fkey/i.test(message))
  )
}

function isDocTypeEnumError(message: string) {
  return /invalid input value for enum .*doc_type/i.test(message)
}

function shouldUseSyncOcrFallback(message: string) {
  return /enqueue_case_job/i.test(message) && (/schema cache/i.test(message) || /function/i.test(message))
}

function buildLowConfidenceWarning(fileName: string, confidence: number) {
  return `${fileName}: OCR confidence is ${Math.round(confidence * 100)}%. Upload a clearer image if any prefilled field looks wrong.`
}

function formatUploadError(message: string, code?: string) {
  if (code === '42P17' || /42P17/i.test(message) || /infinite recursion detected in policy/i.test(message)) {
    return 'Supabase RLS policy recursion (42P17). Apply the latest migration so is_staff runs as SECURITY DEFINER.'
  }

  return message
}

function getCaseInsertHint(message: string) {
  if (/row-level security/i.test(message) || /violates row-level security policy/i.test(message)) {
    return 'Case insert blocked by RLS policy. Apply latest Supabase migrations and ensure your attorney user has firm membership.'
  }

  if (/relation .* does not exist/i.test(message) || /schema cache/i.test(message)) {
    return 'Database schema is out of date. Run Supabase migrations, then retry.'
  }

  return message
}

function isRlsInsertError(message: string) {
  return /row-level security/i.test(message) || /violates row-level security policy/i.test(message)
}

async function ensureProfileRow(
  supabase: QueryClient,
  payload: { userId: string; email: string; firstName: string; lastName: string }
) {
  const insertPayload: Record<string, unknown> = {
    id: payload.userId,
    user_id: payload.userId,
    email: payload.email || null,
    full_name: `${payload.firstName || ''} ${payload.lastName || ''}`.trim() || payload.email || null,
  }

  while (Object.keys(insertPayload).length) {
    const { error } = await supabase.from('profiles').upsert(insertPayload, { onConflict: 'id' })
    if (!error) return

    if (!isSchemaDriftError(error.message, error.code)) return

    const missingColumn = getMissingColumnName(error.message)
    if (missingColumn && missingColumn in insertPayload) {
      delete insertPayload[missingColumn]
      continue
    }

    let removedAny = false
    for (const column of ['user_id', 'email', 'full_name']) {
      if (column in insertPayload) {
        delete insertPayload[column]
        removedAny = true
      }
    }
    if (!removedAny) return
  }
}

async function resolveDriverId(
  supabase: QueryClient,
  payload: { userId: string; email: string; firstName: string; lastName: string }
) {
  await ensureProfileRow(supabase, payload)

  const byUserId = await supabase
    .from('drivers')
    .select('id')
    .eq('user_id', payload.userId)
    .limit(1)
    .maybeSingle<{ id: string }>()
  if (!byUserId.error && byUserId.data?.id) return byUserId.data.id

  const upsertPayload = {
    id: payload.userId,
    user_id: payload.userId,
    first_name: payload.firstName || null,
    last_name: payload.lastName || null,
    email: payload.email || null,
  }

  const upsertRes = await supabase
    .from('drivers')
    .upsert(upsertPayload, { onConflict: 'user_id' })
    .select('id')
    .single<{ id: string }>()
  if (!upsertRes.error && upsertRes.data?.id) return upsertRes.data.id

  const byId = await supabase.from('drivers').select('id').eq('id', payload.userId).limit(1).maybeSingle<{ id: string }>()
  if (!byId.error && byId.data?.id) {
    return byId.data.id
  }

  return null
}

async function findDriverIdByEmail(supabase: QueryClient, email: string) {
  const normalizedEmail = email.trim().toLowerCase()
  if (!normalizedEmail) return null

  const byEmail = await supabase
    .from('drivers')
    .select('id')
    .eq('email', normalizedEmail)
    .limit(1)
    .maybeSingle<{ id: string }>()

  return !byEmail.error && byEmail.data?.id ? byEmail.data.id : null
}

async function insertCaseSafe(
  supabase: QueryClient,
  payload: Record<string, unknown>,
  context?: CaseInsertContext
): Promise<{ id: string } | { error: string }> {
  async function attemptInsert(client: QueryClient) {
    const insertPayload = { ...payload }
    let lastMessage = 'Could not create case record.'
    let attemptedDriverResolution = false

    while (Object.keys(insertPayload).length) {
      const { data, error } = await client.from('cases').insert(insertPayload).select('id').single<{ id: string }>()

      if (!error) {
        return { id: data.id } as const
      }

      lastMessage = error.message

      if (!attemptedDriverResolution && context?.allowCreate && isDriverConstraintError(error.message)) {
        attemptedDriverResolution = true
        const resolvedDriverId = await resolveDriverId(client, context)
        if (resolvedDriverId) {
          const retry = await client
            .from('cases')
            .insert({ ...insertPayload, driver_id: resolvedDriverId })
            .select('id')
            .single<{ id: string }>()
          if (!retry.error) {
            return { id: retry.data.id } as const
          }
          lastMessage = retry.error.message
        }

        if ('driver_id' in insertPayload) {
          delete insertPayload.driver_id
          continue
        }
      }

      const missingColumn = getMissingColumnName(error.message)
      if (!isSchemaDriftError(error.message, error.code)) break

      if (missingColumn && missingColumn in insertPayload) {
        delete insertPayload[missingColumn]
        continue
      }

      let removedAny = false
      for (const column of [
        'metadata',
        'notes',
        'created_by',
        'assigned_attorney_user_id',
        'attorney_firm_id',
        'agency_id',
        'fleet_id',
      ]) {
        if (column in insertPayload) {
          delete insertPayload[column]
          removedAny = true
        }
      }
      if (!removedAny) break
    }

    return { error: lastMessage } as const
  }

  const scopedInsert = await attemptInsert(supabase)
  if ('id' in scopedInsert) {
    return scopedInsert
  }

  const lastMessage = scopedInsert.error
  if (!context || (!isRlsInsertError(lastMessage) && !isDriverConstraintError(lastMessage))) {
    return { error: lastMessage }
  }

  try {
    const admin = createServiceRoleClient()
    const adminInsert = await attemptInsert(admin)
    if ('id' in adminInsert) {
      return adminInsert
    }
    return { error: adminInsert.error }
  } catch {
    return {
      error:
        'Case insert blocked by RLS or driver relationship checks. Verify latest migrations and driver records for this account.',
    }
  }
}

async function insertDocumentSafe(
  supabase: QueryClient,
  payload: Record<string, unknown>
) {
  const insertPayload = { ...payload }

  while (true) {
    const { data, error } = await supabase.from('documents').insert(insertPayload).select('id').single<{ id: string }>()

    if (!error) return data.id

    if (isDocTypeEnumError(error.message) && 'doc_type' in insertPayload) {
      delete insertPayload.doc_type
      continue
    }

    if (!/column .* does not exist/i.test(error.message) && error.code !== 'PGRST204') {
      throw new Error(error.message)
    }

    const match = error.message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i)
    if (match?.[1] && match[1] in insertPayload) {
      delete insertPayload[match[1]]
      continue
    }

    delete insertPayload.ocr_status
    delete insertPayload.ocr_confidence
    delete insertPayload.ocr_extracted
    delete insertPayload.ocr_payload

    if (!Object.keys(insertPayload).length) {
      throw new Error('Unable to insert document: schema is missing required columns.')
    }
  }
}

async function updateDocumentSafe(
  supabase: QueryClient,
  documentId: string,
  patch: Record<string, unknown>
) {
  const payload = { ...patch }

  while (Object.keys(payload).length) {
    const { error } = await supabase.from('documents').update(payload).eq('id', documentId)

    if (!error) return

    if (!/column .* does not exist/i.test(error.message) && error.code !== 'PGRST204') {
      throw new Error(error.message)
    }

    const match = error.message.match(/column\s+"?([a-zA-Z0-9_]+)"?\s+does not exist/i)
    if (match?.[1] && match[1] in payload) {
      delete payload[match[1]]
      continue
    }

    delete payload.ocr_status
    delete payload.ocr_confidence
    delete payload.ocr_extracted
    delete payload.ocr_payload
  }
}

async function applyResolvedOcrToDocumentAndCase(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: {
    caseId: string
    documentId: string
    confidence: number
    fields: Record<string, unknown>
    payload: unknown
  }
) {
  await updateDocumentSafe(supabase, params.documentId, {
    ocr_status: 'READY',
    ocr_confidence: params.confidence,
    ocr_extracted: params.fields,
    ocr_payload: params.payload,
  })

  const { data: caseRow } = await supabase
    .from('cases')
    .select('state, citation_number, violation_code, county, court_date, ocr_text')
    .eq('id', params.caseId)
    .single<{
      state: string | null
      citation_number: string | null
      violation_code: string | null
      county: string | null
      court_date: string | null
      ocr_text: string | null
    }>()

  if (caseRow) {
    const updates: Record<string, unknown> = {}
    if (!caseRow.state && params.fields.state) updates.state = params.fields.state
    if (!caseRow.citation_number && params.fields.ticket) updates.citation_number = params.fields.ticket
    if (!caseRow.violation_code && (params.fields.violationType || params.fields.violationTypes)) {
      updates.violation_code = params.fields.violationType || params.fields.violationTypes
    }
    if (!caseRow.county && params.fields.courtCounty) updates.county = params.fields.courtCounty
    if (!caseRow.ocr_text) {
      const ocrText = buildTicketOcrText(params.fields)
      if (ocrText) updates.ocr_text = ocrText
    }

    const parsedCourtDate = parseDateToYmd(String(params.fields.courtDate || ''))
    if (!caseRow.court_date && parsedCourtDate) updates.court_date = parsedCourtDate

    if (Object.keys(updates).length) {
      await supabase.from('cases').update(updates).eq('id', params.caseId)
    }
  }

  return {
    ok: true,
    message: '',
    confidence: params.confidence,
  }
}

async function runOcrForDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: { caseId: string; documentId: string; storagePath: string }
): Promise<{ ok: boolean; message: string; confidence: number }> {
  await updateDocumentSafe(supabase, params.documentId, { ocr_status: 'PROCESSING' })

  const signed = await supabase.storage.from('case-documents').createSignedUrl(params.storagePath, 60 * 20)
  if (signed.error || !signed.data?.signedUrl) {
    await updateDocumentSafe(supabase, params.documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: signed.error?.message || 'Could not create signed URL.' },
    })
    return {
      ok: false,
      message: signed.error?.message || 'Could not create signed URL.',
      confidence: 0,
    }
  }

  const ocr = await runTicketOcrFromPublicUrl(signed.data.signedUrl)
  if (!ocr.ok) {
    await updateDocumentSafe(supabase, params.documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: ocr.error || 'OCR failed', raw: ocr.raw },
    })
    return {
      ok: false,
      message: ocr.error || 'OCR failed.',
      confidence: 0,
    }
  }

  return applyResolvedOcrToDocumentAndCase(supabase, {
    caseId: params.caseId,
    documentId: params.documentId,
    confidence: ocr.confidence,
    fields: ocr.fields,
    payload: ocr.raw,
  })
}

async function applyPreviewOcrForDocument(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: { caseId: string; documentId: string; preview: OcrPreviewTokenPayload }
): Promise<{ ok: boolean; message: string; confidence: number }> {
  return applyResolvedOcrToDocumentAndCase(supabase, {
    caseId: params.caseId,
    documentId: params.documentId,
    confidence: params.preview.confidence,
    fields: params.preview.fields,
    payload: {
      source: 'INTAKE_PREVIEW_REUSED',
      reused_preview: true,
      issued_at: new Date(params.preview.iat).toISOString(),
    },
  })
}

export async function processIntakeSubmission(formData: FormData): Promise<string> {
  const state = clean(formData.get('state')).toUpperCase()
  const citation = clean(formData.get('citation_number'))
  const violationTypes = clean(formData.get('violation_types'))
  const dateOfViolation = clean(formData.get('date_of_violation'))
  const firstName = clean(formData.get('first_name'))
  const lastName = clean(formData.get('last_name'))

  if (!state || !citation || !violationTypes || !dateOfViolation || !firstName || !lastName) {
    return '/intake?message=Please%20fill%20all%20required%20fields.'
  }

  const payload = {
    first_name: firstName,
    last_name: lastName,
    email: clean(formData.get('email')),
    phone_number: clean(formData.get('phone_number')),
    did_receive_ticket: yesNo(formData.get('did_receive_ticket')),
    broker_name: clean(formData.get('broker_name')),
    broker_email: clean(formData.get('broker_email')),
    broker_phone: clean(formData.get('broker_phone')),
    broker_type: clean(formData.get('broker_type')),
    broker_contact_preference: clean(formData.get('broker_contact_preference')),
    citation_number: citation,
    violation_types: violationTypes,
    date_of_violation: dateOfViolation,
    accident: yesNo(formData.get('accident')),
    injuries: yesNo(formData.get('injuries')),
    fatality: yesNo(formData.get('fatality')),
    towing: yesNo(formData.get('towing')),
    cdl_driver: yesNo(formData.get('cdl_driver')),
    while_driving_commercial_vehicle: yesNo(formData.get('while_driving_commercial_vehicle')),
    state,
    court_id: clean(formData.get('court_id')),
    do_you_have_court_date: yesNo(formData.get('do_you_have_court_date')),
    court_date: clean(formData.get('court_date')),
    court_time: clean(formData.get('court_time')),
    court_address: clean(formData.get('court_address')),
    court_county: clean(formData.get('court_county')),
    notes: clean(formData.get('notes')),
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return '/login?message=Please%20sign%20in%20again.'
  }

  const profileById = await supabase
    .from('profiles')
    .select('system_role, email, full_name')
    .eq('id', user.id)
    .maybeSingle<{ system_role: string | null; email: string | null; full_name: string | null }>()
  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('system_role, email, full_name')
        .eq('user_id', user.id)
        .maybeSingle<{ system_role: string | null; email: string | null; full_name: string | null }>()
    ).data
  const role = normalizePlatformRole(profileByUserId?.system_role)
  const attorneyFirmMembership =
    isAttorneyRole(role)
      ? await supabase
          .from('attorney_firm_memberships')
          .select('firm_id')
          .eq('user_id', user.id)
          .order('created_at', { ascending: true })
          .limit(1)
          .maybeSingle<{ firm_id: string }>()
      : null
  const attorneyFirmId = attorneyFirmMembership?.data?.firm_id ?? null

  const agencyMembership = await supabase
    .from('agency_memberships')
    .select('agency_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ agency_id: string }>()
  let agencyId = agencyMembership.data?.agency_id ?? null

  const selectedFleetId = clean(formData.get('fleet_id'))
  const allowedFleetIds = new Set(await getAccessibleFleetIds(supabase, user.id))
  const defaultFleetId = Array.from(allowedFleetIds)[0] ?? null
  const fleetId = selectedFleetId && allowedFleetIds.has(selectedFleetId) ? selectedFleetId : defaultFleetId

  if (!agencyId && fleetId) {
    const fleetRes = await supabase
      .from('fleets')
      .select('agency_id')
      .eq('id', fleetId)
      .maybeSingle<{ agency_id: string | null }>()
    agencyId = fleetRes.data?.agency_id ?? null
  }

  const submittedAt = new Date().toISOString()
  const caseSource = isAttorneyRole(role) ? 'ATTORNEY_EXTERNAL' : 'CDL_PROTECT'
  const submittedVia = isAttorneyRole(role) ? 'ATTORNEY_PORTAL' : 'INTERNAL_INTAKE'
  const driverEmail = payload.email || (isDriverRole(role) ? user.email || '' : '')
  const submitterEmail = String(profileByUserId?.email ?? user.email ?? '').trim().toLowerCase()
  const submitterName = String(profileByUserId?.full_name ?? user.email ?? '').trim()
  const canManagePricingVisibility = role === 'AGENCY' || role === 'FLEET'
  const canKeepAgencyPrimary = role === 'AGENCY' || role === 'FLEET'
  const showPricingToFleetDriver =
    canManagePricingVisibility && yesNo(formData.get('show_paid_pricing_to_fleet_driver')) === 'Yes'
  const keepAgencyAsPrimaryContact =
    canKeepAgencyPrimary && yesNo(formData.get('keep_agency_as_primary_contact')) === 'Yes'
  const driverId = isDriverRole(role)
    ? ((await resolveDriverId(supabase, {
        userId: user.id,
        email: driverEmail || user.email || '',
        firstName,
        lastName,
      })) ?? null)
    : await findDriverIdByEmail(supabase, driverEmail)

  const insertCasePayload = {
    owner_id: user.id,
    user_id: user.id,
    created_by: user.id,
    driver_id: driverId,
    agency_id: agencyId,
    fleet_id: fleetId,
    assigned_attorney_user_id: isAttorneyRole(role) ? user.id : null,
    attorney_firm_id: attorneyFirmId,
    submitter_email: submitterEmail || user.email || null,
    submitter_user_id: user.id,
    show_paid_pricing_to_fleet_driver: showPricingToFleetDriver,
    keep_agency_as_primary_contact: keepAgencyAsPrimaryContact,
    primary_contact_type: keepAgencyAsPrimaryContact ? 'AGENCY' : 'SUBMITTER',
    payment_flow_status: 'INTAKE_SUBMITTED',
    state: payload.state,
    county: payload.court_county || null,
    citation_number: payload.citation_number,
    violation_code: payload.violation_types,
    violation_date: parseDateToYmd(payload.date_of_violation),
    court_date: payload.court_date || null,
    notes: buildNotes(payload),
    metadata: {
      ...payload,
      case_source: caseSource,
      submitted_via: submittedVia,
      submitted_by_role: role,
      submitted_by_user_id: user.id,
      submitted_at: submittedAt,
      submitter_name: submitterName || null,
      submitter_email: submitterEmail || user.email || null,
      driver_name: `${firstName} ${lastName}`.trim(),
      driver_email: driverEmail || null,
      driver_phone: payload.phone_number || null,
      show_paid_pricing_to_fleet_driver: showPricingToFleetDriver,
      keep_agency_as_primary_contact: keepAgencyAsPrimaryContact,
      primary_contact_type: keepAgencyAsPrimaryContact ? 'AGENCY' : 'SUBMITTER',
      primary_contact_name: submitterName || null,
      primary_contact_email: submitterEmail || user.email || null,
    },
  }

  const caseInsert = await insertCaseSafe(supabase, insertCasePayload, {
    userId: user.id,
    email: driverEmail || user.email || '',
    firstName,
    lastName,
    allowCreate: isDriverRole(role),
  })
  const insertedId = 'id' in caseInsert ? caseInsert.id : ''

  if (!insertedId && 'error' in caseInsert) {
    return `/intake?message=${encodeURIComponent(getCaseInsertHint(caseInsert.error))}`
  }

  if (!insertedId) {
    return '/intake?message=Could%20not%20create%20case%20record.'
  }

  const ticketFiles = formData
    .getAll('ticket_files')
    .filter((entry): entry is File => entry instanceof File && entry.size > 0)
  const verifiedPreviews = new Map<string, OcrPreviewTokenPayload>()
  for (const entry of formData.getAll('ocr_preview_token')) {
    const verified = verifyOcrPreviewToken(String(entry ?? ''), user.id)
    if (verified.ok) {
      verifiedPreviews.set(verified.payload.fileHash, verified.payload)
    }
  }

  const uploadErrors: string[] = []
  let queuedOcrCount = 0
  let reusedPreviewCount = 0

  for (const file of ticketFiles) {
    if (file.size > MAX_UPLOAD_BYTES) {
      uploadErrors.push(`${file.name}: file exceeds 12MB.`)
      continue
    }

    const safeName = cleanFileName(file.name || 'ticket-file')
    const storagePath = `${insertedId}/intake-${Date.now()}-${safeName}`

    const uploadResult = await supabase.storage.from('case-documents').upload(storagePath, file, {
      contentType: file.type || 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    })

    if (uploadResult.error) {
      uploadErrors.push(
        `${file.name}: ${formatUploadError(uploadResult.error.message)}`
      )
      continue
    }

    try {
      const fileHash = verifiedPreviews.size ? await hashBrowserFile(file) : ''
      const preview = fileHash ? verifiedPreviews.get(fileHash) ?? null : null
      const docId = await insertDocumentSafe(supabase, {
        case_id: insertedId,
        doc_type: 'OTHER',
        filename: file.name,
        storage_path: storagePath,
        uploaded_by: user.id,
        ocr_status: preview ? 'READY' : SYNC_OCR_ON_SUBMIT ? 'PROCESSING' : 'PENDING',
      })

      if (preview) {
        const previewResult = await applyPreviewOcrForDocument(supabase, {
          caseId: insertedId,
          documentId: docId,
          preview,
        })
        reusedPreviewCount += 1

        if (!previewResult.ok) {
          uploadErrors.push(`${file.name}: OCR preview reuse failed (${previewResult.message})`)
        } else if (previewResult.confidence < LOW_OCR_CONFIDENCE_THRESHOLD) {
          uploadErrors.push(buildLowConfidenceWarning(file.name, previewResult.confidence))
        }
      } else if (SYNC_OCR_ON_SUBMIT) {
        const ocrResult = await runOcrForDocument(supabase, {
          caseId: insertedId,
          documentId: docId,
          storagePath,
        })

        if (!ocrResult.ok) {
          uploadErrors.push(`${file.name}: OCR failed (${ocrResult.message})`)
        } else if (ocrResult.confidence < LOW_OCR_CONFIDENCE_THRESHOLD) {
          uploadErrors.push(buildLowConfidenceWarning(file.name, ocrResult.confidence))
        }
      } else {
        const queued = await enqueueDocumentOcrJob(supabase, {
          caseId: insertedId,
          documentId: docId,
          storagePath,
          requestedBy: user.id,
          source: 'INTAKE_UPLOAD',
        })

        if (!queued.ok) {
          if (shouldUseSyncOcrFallback(queued.message)) {
            const fallback = await runOcrForDocument(supabase, {
              caseId: insertedId,
              documentId: docId,
              storagePath,
            })

            if (!fallback.ok) {
              uploadErrors.push(`${file.name}: OCR fallback failed (${fallback.message})`)
            } else if (fallback.confidence < LOW_OCR_CONFIDENCE_THRESHOLD) {
              uploadErrors.push(buildLowConfidenceWarning(file.name, fallback.confidence))
            }
          } else {
            await updateDocumentSafe(supabase, docId, {
              ocr_status: 'FAILED',
              ocr_payload: {
                error: queued.message,
                source: 'OCR_JOB_QUEUE',
              },
            })
            uploadErrors.push(`${file.name}: OCR queue failed (${queued.message})`)
          }
        } else {
          queuedOcrCount += 1
        }
      }
    } catch (error) {
      uploadErrors.push(`${file.name}: ${error instanceof Error ? error.message : 'document insert failed'}`)
    }
  }

  const dashboardBase = isAttorneyRole(role) ? '/attorney/dashboard' : '/dashboard'

  let matchingMessage = ''
  try {
    const matching = await runAttorneyMatchingForCase({
      caseId: insertedId,
      actorUserId: user.id,
    })

    if (matching.ok && matching.mode === 'PRICING_AVAILABLE' && matching.quoteId) {
      return `/checkout/${encodeURIComponent(matching.quoteId)}`
    }

    if (matching.ok && matching.mode === 'OUTREACH_SENT') {
      return `/waiting/${encodeURIComponent(insertedId)}`
    }

    if (!matching.ok) {
      matchingMessage = ` Attorney matching warning: ${matching.message}`
    }
  } catch (error) {
    matchingMessage = ` Attorney matching warning: ${error instanceof Error ? error.message : 'matching unavailable'}`
  }

  if (uploadErrors.length) {
    const query = new URLSearchParams()
    query.set('case', insertedId)
    query.set('message', `Ticket created. Upload/OCR issues: ${uploadErrors.join(' | ')}${matchingMessage}`)
    return `${dashboardBase}?${query.toString()}`
  }

  return `${dashboardBase}?case=${encodeURIComponent(insertedId)}&message=${encodeURIComponent(
    `Traffic ticket added successfully.${reusedPreviewCount ? ` Reused upload OCR preview for ${reusedPreviewCount} file${reusedPreviewCount === 1 ? '' : 's'}.` : ''}${queuedOcrCount ? ' OCR is reading the uploaded ticket now and may take up to a minute.' : ''}${matchingMessage}`
  )}`
}
