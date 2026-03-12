import { NextResponse } from 'next/server'
import { runAttorneyMatchingForCase } from '@/app/lib/matching/attorneyMatching'
import { buildTicketOcrText, runTicketOcrFromFile } from '@/app/lib/server/ocr'
import { writePlatformLog } from '@/app/lib/server/platform-logs'
import { validateTicketUpload } from '@/app/lib/server/ticket-upload'
import { normalizePlatformRole } from '@/app/lib/roles'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'
import { createClient } from '@/app/lib/supabase/server'

export const runtime = 'nodejs'

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
  const match = s.match(mdy)
  if (match) {
    const mm = match[1]
    const dd = match[2]
    const yy = match[3]
    const year = yy.length === 2 ? `20${yy}` : yy
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
  }

  return null
}

function isTruthy(value: string) {
  const normalized = value.trim().toLowerCase()
  return normalized === 'yes' || normalized === 'true' || normalized === '1'
}

function isCaseInsertScopeError(message: string) {
  return (
    /row-level security/i.test(message) ||
    /violates row-level security policy/i.test(message) ||
    (/driver_id/i.test(message) &&
      (/foreign key constraint/i.test(message) ||
        /not-null constraint/i.test(message) ||
        /cases_driver_id_fkey/i.test(message)))
  )
}

async function rollbackFailedSubmission(
  supabase: Awaited<ReturnType<typeof createClient>>,
  params: { caseId: string; storagePath?: string | null }
) {
  const cleanupErrors: string[] = []

  if (params.storagePath) {
    const storageCleanup = await supabase.storage.from('case-documents').remove([params.storagePath])
    if (storageCleanup.error) {
      cleanupErrors.push(storageCleanup.error.message)
    }
  }

  const caseCleanup = await supabase.from('cases').delete().eq('id', params.caseId)
  if (caseCleanup.error) {
    cleanupErrors.push(caseCleanup.error.message)
  }

  return cleanupErrors
}

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      await writePlatformLog({
        severity: 'WARN',
        eventType: 'API_TICKET_SUBMIT_UNAUTHORIZED',
        source: 'api.tickets.submit',
        message: 'Unauthorized ticket submit attempt.',
        requestPath: '/api/tickets/submit',
      })
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const formData = await request.formData()
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
    const courtAddress = clean(formData.get('court_address'))
    const state = clean(formData.get('state')).toUpperCase()
    const county = clean(formData.get('county')).toUpperCase()
    const courtName = clean(formData.get('court_name'))
    const submitterEmail = clean(formData.get('submitter_email')).toLowerCase() || String(profileByUserId?.email ?? user.email ?? '').toLowerCase()
    const submitterName = clean(formData.get('submitter_name')) || String(profileByUserId?.full_name ?? user.email ?? '').trim()
    const cdlFlagRaw = clean(formData.get('cdl_flag'))
    const canManagePricingVisibility = role === 'AGENCY' || role === 'FLEET'
    const canKeepAgencyPrimary = role === 'AGENCY' || role === 'FLEET'
    const showPricingToFleetDriver =
      canManagePricingVisibility && isTruthy(clean(formData.get('show_paid_pricing_to_fleet_driver')))
    const keepAgencyAsPrimaryContact =
      canKeepAgencyPrimary && isTruthy(clean(formData.get('keep_agency_as_primary_contact')))

    const fileEntry = formData.get('ticket_image')
    if (!(fileEntry instanceof File) || fileEntry.size === 0) {
      await writePlatformLog({
        severity: 'WARN',
        eventType: 'API_TICKET_SUBMIT_VALIDATION',
        source: 'api.tickets.submit',
        message: 'ticket_image missing.',
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
      })
      return NextResponse.json({ ok: false, error: 'ticket_image is required.' }, { status: 400 })
    }

    if (!state || !county || !courtAddress || !submitterEmail) {
      await writePlatformLog({
        severity: 'WARN',
        eventType: 'API_TICKET_SUBMIT_VALIDATION',
        source: 'api.tickets.submit',
        message: 'Required form fields missing.',
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
      })
      return NextResponse.json(
        {
          ok: false,
          error: 'court_address, state, county, and submitter_email are required.',
        },
        { status: 400 }
      )
    }

    const uploadError = validateTicketUpload(fileEntry, 'ticket_image')
    if (uploadError) {
      await writePlatformLog({
        severity: 'WARN',
        eventType: 'API_TICKET_SUBMIT_VALIDATION',
        source: 'api.tickets.submit',
        message: uploadError,
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
      })
      return NextResponse.json({ ok: false, error: uploadError }, { status: 400 })
    }

    const citationFallback = clean(formData.get('citation_number')) || `PENDING-${Date.now()}`
    const violationInput = clean(formData.get('violations')) || clean(formData.get('violation_code'))
    const violationDateInput = clean(formData.get('violation_date')) || clean(formData.get('date_of_violation'))
    const courtDateInput = clean(formData.get('court_date'))
    const caseInsertPayload = {
      owner_id: user.id,
      user_id: user.id,
      driver_id: null,
      submitter_user_id: user.id,
      submitter_email: submitterEmail,
      show_paid_pricing_to_fleet_driver: showPricingToFleetDriver,
      keep_agency_as_primary_contact: keepAgencyAsPrimaryContact,
      primary_contact_type: keepAgencyAsPrimaryContact ? 'AGENCY' : 'SUBMITTER',
      state,
      county,
      court_name: courtName || null,
      court_address: courtAddress,
      citation_number: citationFallback,
      violation_code: violationInput || null,
      violation_date: parseDateToYmd(violationDateInput),
      court_date: parseDateToYmd(courtDateInput),
      status: 'INTAKE_RECEIVED',
      payment_flow_status: 'INTAKE_SUBMITTED',
      metadata: {
        cdl_driver: isTruthy(cdlFlagRaw),
        source: 'API_TICKET_SUBMIT',
        submitted_via: 'DRIVER_OR_FLEET',
        submitted_by_role: role,
        submitter_name: submitterName || null,
        submitter_email: submitterEmail,
        show_paid_pricing_to_fleet_driver: showPricingToFleetDriver,
        keep_agency_as_primary_contact: keepAgencyAsPrimaryContact,
        primary_contact_type: keepAgencyAsPrimaryContact ? 'AGENCY' : 'SUBMITTER',
      },
    }

    let caseInsert = await supabase
      .from('cases')
      .insert(caseInsertPayload)
      .select('id')
      .single<{ id: string }>()

    if (caseInsert.error && isCaseInsertScopeError(caseInsert.error.message)) {
      try {
        const admin = createServiceRoleClient()
        caseInsert = await admin.from('cases').insert(caseInsertPayload).select('id').single<{ id: string }>()
      } catch {
        // Keep the original scoped error if service-role fallback is unavailable.
      }
    }

    if (caseInsert.error || !caseInsert.data?.id) {
      await writePlatformLog({
        severity: 'ERROR',
        eventType: 'API_TICKET_SUBMIT_CASE_INSERT_FAILED',
        source: 'api.tickets.submit',
        message: caseInsert.error?.message || 'Unable to create case.',
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
      })
      return NextResponse.json({ ok: false, error: caseInsert.error?.message || 'Unable to create case.' }, { status: 400 })
    }

    const caseId = caseInsert.data.id
    const safeName = cleanFileName(fileEntry.name || 'ticket-upload')
    const storagePath = `${caseId}/ticket-${Date.now()}-${safeName}`

    const upload = await supabase.storage.from('case-documents').upload(storagePath, fileEntry, {
      contentType: fileEntry.type || 'application/octet-stream',
      cacheControl: '3600',
      upsert: false,
    })

    if (upload.error) {
      const cleanupErrors = await rollbackFailedSubmission(supabase, { caseId })
      await writePlatformLog({
        severity: 'ERROR',
        eventType: 'API_TICKET_SUBMIT_UPLOAD_FAILED',
        source: 'api.tickets.submit',
        message: upload.error.message,
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
        metadata: {
          case_id: caseId,
          cleanup_errors: cleanupErrors,
        },
      })
      return NextResponse.json({ ok: false, error: upload.error.message, caseId }, { status: 400 })
    }

    const documentInsert = await supabase.from('documents').insert({
      case_id: caseId,
      doc_type: 'OTHER',
      filename: fileEntry.name,
      storage_path: storagePath,
      uploaded_by: user.id,
      ocr_status: 'PENDING',
    })
    if (documentInsert.error) {
      const cleanupErrors = await rollbackFailedSubmission(supabase, { caseId, storagePath })
      await writePlatformLog({
        severity: 'ERROR',
        eventType: 'API_TICKET_SUBMIT_DOCUMENT_INSERT_FAILED',
        source: 'api.tickets.submit',
        message: documentInsert.error.message,
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
        metadata: {
          case_id: caseId,
          cleanup_errors: cleanupErrors,
        },
      })
      return NextResponse.json({ ok: false, error: documentInsert.error.message, caseId }, { status: 400 })
    }

    const ocr = await runTicketOcrFromFile(fileEntry)
    if (ocr.ok) {
      const updates: Record<string, unknown> = {
        ocr_text: buildTicketOcrText(ocr.fields) || null,
      }
      if (ocr.fields.ticket) updates['citation_number'] = ocr.fields.ticket
      if (ocr.fields.violationType || ocr.fields.violationTypes) {
        updates['violation_code'] = ocr.fields.violationType || ocr.fields.violationTypes
      }
      if (ocr.fields.courtDate && !courtDateInput) {
        const parsed = parseDateToYmd(String(ocr.fields.courtDate))
        if (parsed) updates['court_date'] = parsed
      }

      await supabase.from('cases').update(updates).eq('id', caseId)
      await supabase
        .from('documents')
        .update({
          ocr_status: 'READY',
          ocr_extracted: ocr.fields,
          ocr_payload: ocr.raw ?? null,
        })
        .eq('case_id', caseId)
        .eq('storage_path', storagePath)
    } else {
      await supabase
        .from('documents')
        .update({
          ocr_status: 'FAILED',
          ocr_payload: { error: ocr.error ?? 'OCR failed', raw: ocr.raw ?? null },
        })
        .eq('case_id', caseId)
        .eq('storage_path', storagePath)
    }

    const matching = await runAttorneyMatchingForCase({
      caseId,
      actorUserId: user.id,
    })

    if (!matching.ok) {
      await writePlatformLog({
        severity: 'ERROR',
        eventType: 'API_TICKET_SUBMIT_MATCHING_FAILED',
        source: 'api.tickets.submit',
        message: matching.message,
        actorUserId: user.id,
        requestPath: '/api/tickets/submit',
        metadata: { case_id: caseId },
      })
      return NextResponse.json({
        ok: true,
        caseId,
        mode: 'MATCHING_PENDING',
        warning: matching.message,
        redirectUrl: `/waiting/${encodeURIComponent(caseId)}`,
      })
    }

    await writePlatformLog({
      severity: 'INFO',
      eventType: 'API_TICKET_SUBMIT_SUCCESS',
      source: 'api.tickets.submit',
      message: `Ticket submit completed with ${matching.mode}.`,
      actorUserId: user.id,
      requestPath: '/api/tickets/submit',
      metadata: { case_id: caseId, mode: matching.mode, quote_id: matching.quoteId ?? null },
    })

    if (matching.mode === 'PRICING_AVAILABLE' && matching.quoteId) {
      return NextResponse.json({
        ok: true,
        caseId,
        mode: matching.mode,
        quoteId: matching.quoteId,
        redirectUrl: `/checkout/${encodeURIComponent(matching.quoteId)}`,
      })
    }

    return NextResponse.json({
      ok: true,
      caseId,
      mode: matching.mode,
      redirectUrl: `/waiting/${encodeURIComponent(caseId)}`,
    })
  } catch (error) {
    await writePlatformLog({
      severity: 'ERROR',
      eventType: 'API_TICKET_SUBMIT_EXCEPTION',
      source: 'api.tickets.submit',
      message: error instanceof Error ? error.message : 'Ticket submission failed.',
      requestPath: '/api/tickets/submit',
    })
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Ticket submission failed.',
      },
      { status: 500 }
    )
  }
}
