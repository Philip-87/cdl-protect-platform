import type { SupabaseClient } from '@supabase/supabase-js'
import { getCaseAttorneyUpdateDate } from '@/app/lib/cases/display'
import { runAttorneyMatchingForCase } from '@/app/lib/matching/attorneyMatching'
import {
  buildCalendarItemHref,
  loadCalendarPlatformItem,
  type CalendarItemRef,
} from '@/app/lib/server/attorney-calendar-runtime'
import { sendEmail } from '@/app/lib/server/email'
import {
  syncExternalCalendarExport,
  syncExternalCalendarImport,
} from '@/app/lib/server/calendar-sync'
import { buildTicketOcrText, runTicketOcrFromPublicUrl } from '@/app/lib/server/ocr'
import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

const OCR_SIGNED_URL_TTL_SECONDS = 60 * 20
const DEFAULT_BATCH_LIMIT = 10
const MAX_BATCH_LIMIT = 50

type JsonObject = Record<string, unknown>

type ClaimedJob = {
  id: string
  job_type: string
  case_id: string | null
  document_id: string | null
  payload: JsonObject | null
  attempts: number
  max_attempts: number
}

type CompleteJobRpcRow = {
  job_id: string
  final_status: string
  attempts: number
  next_run_after: string | null
  dead_lettered: boolean
}

type WorkerJobResult = {
  jobId: string
  jobType: string
  status: 'SUCCEEDED' | 'RETRY' | 'DEAD' | 'FAILED'
  error?: string
}

export type WorkerBatchResult = {
  claimed: number
  succeeded: number
  retried: number
  dead: number
  failed: number
  jobs: WorkerJobResult[]
}

function asRecord(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as JsonObject
}

function asString(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
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

function resolveWorkerId(input?: string) {
  const raw = String(input ?? '').trim()
  if (raw) return raw
  return `worker-${process.pid}`
}

function isClosedCaseStatus(status: unknown) {
  const normalized = String(status ?? '').trim().toUpperCase()
  return normalized === 'CLOSED' || normalized === 'CANCELLED' || normalized === 'UNABLE_TO_SERVICE'
}

async function enqueuePastCourtAttorneyUpdateRequests(supabase: SupabaseClient) {
  const todayYmd = new Date().toISOString().slice(0, 10)
  const casesRes = await supabase
    .from('cases')
    .select('*')
    .lt('court_date', todayYmd)
    .limit(200)

  if (casesRes.error || !casesRes.data?.length) {
    return 0
  }

  const candidateCases = (casesRes.data as Array<Record<string, unknown>>).filter((row) => {
    if (!row.id || !row.court_date || isClosedCaseStatus(row.status)) return false
    return Boolean(row.assigned_attorney_user_id || row.attorney_firm_id)
  })

  const caseIds = candidateCases.map((row) => String(row.id))
  if (!caseIds.length) {
    return 0
  }

  const taskRes = await supabase
    .from('case_tasks')
    .select('case_id, status, created_at')
    .in('case_id', caseIds)
    .eq('task_type', 'ATTORNEY_UPDATE_REQUEST')
    .limit(2000)

  const existingTaskRows =
    taskRes.error || !taskRes.data ? [] : (taskRes.data as Array<{ case_id: string; status: string; created_at: string | null }>)

  const openTaskCaseIds = new Set(
    existingTaskRows
      .filter((row) => {
        const status = String(row.status ?? '').trim().toUpperCase()
        return status === 'OPEN' || status === 'PENDING'
      })
      .map((row) => row.case_id)
  )

  const taskPayloads: Array<Record<string, unknown>> = []
  const eventPayloads: Array<Record<string, unknown>> = []

  for (const row of candidateCases) {
    const caseId = String(row.id)
    const courtDate = String(row.court_date ?? '').trim()
    const courtDateMs = Date.parse(courtDate)
    if (!courtDate || Number.isNaN(courtDateMs)) continue
    if (openTaskCaseIds.has(caseId)) continue

    const hasTaskAfterCourtDate = existingTaskRows.some((task) => {
      if (task.case_id !== caseId || !task.created_at) return false
      const createdAtMs = Date.parse(task.created_at)
      return !Number.isNaN(createdAtMs) && createdAtMs >= courtDateMs
    })
    if (hasTaskAfterCourtDate) continue

    const attorneyUpdateDate = getCaseAttorneyUpdateDate(row) || String(row.updated_at ?? '').trim()
    if (attorneyUpdateDate) {
      const attorneyUpdateMs = Date.parse(attorneyUpdateDate)
      if (!Number.isNaN(attorneyUpdateMs) && attorneyUpdateMs >= courtDateMs) {
        continue
      }
    }

    taskPayloads.push({
      case_id: caseId,
      task_type: 'ATTORNEY_UPDATE_REQUEST',
      target_role: 'ATTORNEY',
      instructions: 'Court hearing date has passed. Please provide a post-hearing case update.',
      status: 'OPEN',
      due_at: new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString(),
      metadata: {
        automation: true,
        source: 'PAST_COURT_AUTO_UPDATE',
        court_date: courtDate,
      },
    })
    eventPayloads.push({
      case_id: caseId,
      actor_id: null,
      event_type: 'AUTO_ATTORNEY_UPDATE_REQUESTED',
      event_summary: 'Automatic attorney update request created after the court date passed.',
      metadata: {
        source: 'PAST_COURT_AUTO_UPDATE',
        court_date: courtDate,
      },
    })
  }

  if (!taskPayloads.length) {
    return 0
  }

  const taskInsert = await supabase.from('case_tasks').insert(taskPayloads)
  if (taskInsert.error) {
    throw new Error(taskInsert.error.message)
  }

  const eventInsert = await supabase.from('case_events').insert(eventPayloads)
  if (eventInsert.error) {
    throw new Error(eventInsert.error.message)
  }

  return taskPayloads.length
}

async function writeCaseEvent(
  supabase: SupabaseClient,
  params: {
    caseId: string
    eventType: string
    eventSummary: string
    metadata?: JsonObject
  }
) {
  const { error } = await supabase.from('case_events').insert({
    case_id: params.caseId,
    actor_id: null,
    event_type: params.eventType,
    event_summary: params.eventSummary,
    metadata: params.metadata ?? null,
  })

  if (error) {
    throw new Error(error.message)
  }
}

async function updateDocumentSafe(supabase: SupabaseClient, documentId: string, patch: JsonObject) {
  const { error } = await supabase.from('documents').update(patch).eq('id', documentId)
  if (error) {
    throw new Error(error.message)
  }
}

async function applyCaseAutofill(
  supabase: SupabaseClient,
  params: {
    caseId: string
    fields: {
      state?: string
      ticket?: string
      violationType?: string
      violationTypes?: string
      courtCounty?: string
      courtDate?: string
    }
  }
) {
  const { data: caseRow, error } = await supabase
    .from('cases')
    .select('state, citation_number, violation_code, county, court_date, ocr_text')
    .eq('id', params.caseId)
    .maybeSingle<{
      state: string | null
      citation_number: string | null
      violation_code: string | null
      county: string | null
      court_date: string | null
      ocr_text: string | null
    }>()

  if (error || !caseRow) return

  const updates: JsonObject = {}
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

  const parsedCourtDate = parseDateToYmd(params.fields.courtDate || '')
  if (!caseRow.court_date && parsedCourtDate) updates.court_date = parsedCourtDate

  if (!Object.keys(updates).length) return

  const updateRes = await supabase.from('cases').update(updates).eq('id', params.caseId)
  if (updateRes.error) {
    throw new Error(updateRes.error.message)
  }
}

async function maybeRunAttorneyMatchingAfterOcr(supabase: SupabaseClient, caseId: string) {
  const caseRes = await supabase
    .from('cases')
    .select('id, status, attorney_firm_id, county, court_address')
    .eq('id', caseId)
    .maybeSingle<{
      id: string
      status: string | null
      attorney_firm_id: string | null
      county: string | null
      court_address: string | null
    }>()

  if (caseRes.error || !caseRes.data) return
  if (caseRes.data.attorney_firm_id) return

  const status = String(caseRes.data.status ?? '').toUpperCase()
  if (!['INTAKE_RECEIVED', 'NEEDS_REVIEW', 'ATTORNEY_MATCHING'].includes(status)) {
    return
  }

  if (!caseRes.data.county && !caseRes.data.court_address) {
    return
  }

  const [quotesRes, outreachRes, assignmentsRes] = await Promise.all([
    supabase
      .from('case_quotes')
      .select('id')
      .eq('case_id', caseId)
      .in('status', ['OPEN', 'AWAITING_PAYMENT'])
      .limit(1)
      .maybeSingle<{ id: string }>(),
    supabase
      .from('attorney_outreach')
      .select('id')
      .eq('case_id', caseId)
      .eq('status', 'PENDING')
      .limit(1)
      .maybeSingle<{ id: string }>(),
    supabase
      .from('case_assignments')
      .select('id')
      .eq('case_id', caseId)
      .is('accepted_at', null)
      .is('declined_at', null)
      .limit(1)
      .maybeSingle<{ id: string }>(),
  ])

  if (quotesRes.data?.id || outreachRes.data?.id || assignmentsRes.data?.id) {
    return
  }

  const matching = await runAttorneyMatchingForCase({ caseId })
  if (!matching.ok) {
    throw new Error(matching.message)
  }
}

async function processOcrProcessDocumentJob(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = asRecord(job.payload)

  let caseId = asString(job.case_id) || asString(payload.case_id)
  const documentId = asString(job.document_id) || asString(payload.document_id)
  let storagePath = asString(payload.storage_path)

  if (!documentId) {
    throw new Error('OCR job payload is missing document_id.')
  }

  const docRes = await supabase
    .from('documents')
    .select('id, case_id, storage_path')
    .eq('id', documentId)
    .maybeSingle<{ id: string; case_id: string; storage_path: string | null }>()

  if (docRes.error || !docRes.data) {
    throw new Error(docRes.error?.message || 'Document not found for OCR job.')
  }

  if (!caseId) caseId = docRes.data.case_id
  if (!storagePath) storagePath = docRes.data.storage_path || ''

  if (!caseId) {
    throw new Error('OCR job payload is missing case_id.')
  }

  if (!storagePath) {
    throw new Error('OCR job payload is missing storage_path.')
  }

  await updateDocumentSafe(supabase, documentId, {
    ocr_status: 'PROCESSING',
    ocr_payload: {
      source: payload.source || null,
      queued_job_id: job.id,
      started_at: new Date().toISOString(),
    },
  })

  const signed = await supabase.storage
    .from('case-documents')
    .createSignedUrl(storagePath, OCR_SIGNED_URL_TTL_SECONDS)

  if (signed.error || !signed.data?.signedUrl) {
    await updateDocumentSafe(supabase, documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: signed.error?.message || 'Could not create signed URL.' },
    })
    throw new Error(signed.error?.message || 'Could not create signed URL.')
  }

  const ocr = await runTicketOcrFromPublicUrl(signed.data.signedUrl)
  if (!ocr.ok) {
    await updateDocumentSafe(supabase, documentId, {
      ocr_status: 'FAILED',
      ocr_payload: { error: ocr.error || 'OCR failed', raw: ocr.raw },
    })
    throw new Error(ocr.error || 'OCR failed')
  }

  await updateDocumentSafe(supabase, documentId, {
    ocr_status: 'READY',
    ocr_confidence: ocr.confidence,
    ocr_extracted: ocr.fields,
    ocr_payload: ocr.raw,
  })

  await applyCaseAutofill(supabase, {
    caseId,
    fields: {
      state: ocr.fields.state,
      ticket: ocr.fields.ticket,
      violationType: ocr.fields.violationType,
      violationTypes: ocr.fields.violationTypes,
      courtCounty: ocr.fields.courtCounty,
      courtDate: ocr.fields.courtDate,
    },
  })

  await writeCaseEvent(supabase, {
    caseId,
    eventType: 'OCR_COMPLETED',
    eventSummary: 'OCR completed from async worker job.',
    metadata: {
      job_id: job.id,
      document_id: documentId,
      confidence: ocr.confidence,
      source: payload.source || null,
    },
  })

  await maybeRunAttorneyMatchingAfterOcr(supabase, caseId)
}

async function processSlaReminderJob(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = asRecord(job.payload)
  const caseId = asString(job.case_id) || asString(payload.case_id)

  if (!caseId) {
    throw new Error(`${job.job_type} is missing case_id.`)
  }

  const reminderBody =
    asString(payload.body) ||
    `Automated reminder generated for ${job.job_type}. Review case workflow and follow up.`

  const taskInsert = await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: job.job_type,
    target_role: asString(payload.target_role) || null,
    instructions: reminderBody,
    status: 'OPEN',
    due_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    metadata: {
      automation: true,
      job_id: job.id,
      source: 'WORKER',
    },
  })

  if (taskInsert.error) {
    throw new Error(taskInsert.error.message)
  }

  await writeCaseEvent(supabase, {
    caseId,
    eventType: job.job_type,
    eventSummary: `Automation reminder created (${job.job_type}).`,
    metadata: {
      job_id: job.id,
      reminder_body: reminderBody,
    },
  })
}

function formatReminderLead(offsetMinutes: number) {
  if (offsetMinutes >= 10080) {
    const weeks = Math.round(offsetMinutes / 10080)
    return `${weeks} week${weeks === 1 ? '' : 's'} before`
  }
  if (offsetMinutes >= 1440) {
    const days = Math.round(offsetMinutes / 1440)
    return `${days} day${days === 1 ? '' : 's'} before`
  }
  if (offsetMinutes >= 60) {
    const hours = Math.round(offsetMinutes / 60)
    return `${hours} hour${hours === 1 ? '' : 's'} before`
  }
  return `${offsetMinutes} minute${offsetMinutes === 1 ? '' : 's'} before`
}

async function resolveNotificationEmail(supabase: SupabaseClient, userId: string) {
  const profileById = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('id', userId)
    .maybeSingle<{ full_name: string | null; email: string | null }>()

  if (!profileById.error && profileById.data?.email) {
    return {
      email: profileById.data.email,
      name: profileById.data.full_name,
    }
  }

  const profileByUserId = await supabase
    .from('profiles')
    .select('full_name, email')
    .eq('user_id', userId)
    .maybeSingle<{ full_name: string | null; email: string | null }>()

  if (!profileByUserId.error && profileByUserId.data?.email) {
    return {
      email: profileByUserId.data.email,
      name: profileByUserId.data.full_name,
    }
  }

  const authUser = await supabase.auth.admin.getUserById(userId).catch(() => null)
  const email = String(authUser?.data?.user?.email ?? '').trim()
  return {
    email: email || null,
    name: null,
  }
}

async function processDeliverEventReminderJob(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = asRecord(job.payload)
  const sourceKind = asString(payload.source_kind).toLowerCase()
  const itemId = asString(payload.item_id)
  const targetUserId = asString(payload.target_user_id)
  const offsetMinutes = Number.parseInt(String(payload.offset_minutes ?? ''), 10)

  if (!itemId || !targetUserId || !['calendar', 'task', 'case_court'].includes(sourceKind)) {
    throw new Error('Reminder job payload is incomplete.')
  }

  const itemRef = {
    sourceKind: sourceKind as CalendarItemRef['sourceKind'],
    itemId,
  }
  const item = await loadCalendarPlatformItem(supabase, itemRef)
  if (!item) {
    throw new Error('Calendar item not found for reminder delivery.')
  }

  const reminderKey = `event-reminder:${item.platformEventKey}:${Number.isFinite(offsetMinutes) ? offsetMinutes : 0}`
  const existingNotification = await supabase
    .from('in_app_notifications')
    .select('id')
    .eq('user_id', targetUserId)
    .contains('metadata', { delivery_key: reminderKey })
    .maybeSingle<{ id: string }>()

  let notificationId = existingNotification.data?.id ?? ''
  const href = buildCalendarItemHref(item)
  const leadLabel = formatReminderLead(Number.isFinite(offsetMinutes) ? offsetMinutes : 0)
  const whenLabel = new Date(item.startAt).toLocaleString()

  if (!notificationId) {
    const insert = await supabase
      .from('in_app_notifications')
      .insert({
        user_id: targetUserId,
        case_id: item.caseId,
        category: 'CALENDAR_REMINDER',
        title: `Reminder: ${item.title}`,
        body: `${leadLabel}. ${item.title} starts ${whenLabel}.`,
        href,
        delivered_at: new Date().toISOString(),
        metadata: {
          delivery_key: reminderKey,
          source_kind: item.sourceKind,
          item_id: item.itemId,
          event_type: item.eventType,
          offset_minutes: Number.isFinite(offsetMinutes) ? offsetMinutes : 0,
        },
      })
      .select('id')
      .single<{ id: string }>()

    if (insert.error || !insert.data?.id) {
      throw new Error(insert.error?.message || 'Could not create in-app notification.')
    }
    notificationId = insert.data.id
  } else {
    await supabase
      .from('in_app_notifications')
      .update({ delivered_at: new Date().toISOString() })
      .eq('id', notificationId)
      .is('delivered_at', null)
  }

  const inAppDeliveryKey = `${reminderKey}:in-app`
  const inAppExisting = await supabase
    .from('notification_deliveries')
    .select('id')
    .eq('delivery_key', inAppDeliveryKey)
    .maybeSingle<{ id: string }>()

  if (!inAppExisting.data?.id) {
    const inAppInsert = await supabase.from('notification_deliveries').insert({
      notification_id: notificationId,
      user_id: targetUserId,
      channel: 'IN_APP',
      status: 'DELIVERED',
      delivery_key: inAppDeliveryKey,
      sent_at: new Date().toISOString(),
      metadata: {
        job_id: job.id,
        source_kind: item.sourceKind,
        item_id: item.itemId,
      },
    })

    if (inAppInsert.error && inAppInsert.error.code !== '23505') {
      throw new Error(inAppInsert.error.message)
    }
  }

  const recipient = await resolveNotificationEmail(supabase, targetUserId)
  if (!recipient.email) {
    const skippedDelivery = await supabase.from('notification_deliveries').insert({
      notification_id: notificationId,
      user_id: targetUserId,
      channel: 'EMAIL',
      status: 'SKIPPED',
      delivery_key: `${reminderKey}:email`,
      error_text: 'No email address available.',
      metadata: {
        job_id: job.id,
        reason: 'missing_email',
      },
    })
    if (skippedDelivery.error && skippedDelivery.error.code !== '23505') {
      throw new Error(skippedDelivery.error.message)
    }
    return
  }

  const emailDeliveryKey = `${reminderKey}:email`
  const emailExisting = await supabase
    .from('notification_deliveries')
    .select('id')
    .eq('delivery_key', emailDeliveryKey)
    .maybeSingle<{ id: string }>()

  if (emailExisting.data?.id) {
    return
  }

  const emailResult = await sendEmail({
    to: [{ email: recipient.email, name: recipient.name ?? undefined }],
    subject: `CDL Protect reminder: ${item.title}`,
    text: `${leadLabel}. ${item.title} starts ${whenLabel}.\n\nOpen: ${href}`,
    html: `<p>${leadLabel}. <strong>${item.title}</strong> starts ${whenLabel}.</p><p><a href="${href}">Open in CDL Protect</a></p>`,
  })

  const deliveryInsert = await supabase.from('notification_deliveries').insert({
    notification_id: notificationId,
    user_id: targetUserId,
    channel: 'EMAIL',
    status: emailResult.ok ? 'DELIVERED' : 'FAILED',
    delivery_key: emailDeliveryKey,
    sent_at: emailResult.ok ? new Date().toISOString() : null,
    failed_at: emailResult.ok ? null : new Date().toISOString(),
    error_text: emailResult.ok ? null : emailResult.error,
    metadata: {
      job_id: job.id,
      fallback: emailResult.ok && 'fallback' in emailResult ? Boolean(emailResult.fallback) : false,
    },
  })

  if (deliveryInsert.error && deliveryInsert.error.code !== '23505') {
    throw new Error(deliveryInsert.error.message)
  }
}

async function processSyncCalendarImportJob(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = asRecord(job.payload)
  const integrationId = asString(payload.integration_id)
  if (!integrationId) {
    throw new Error('Calendar import job payload is missing integration_id.')
  }
  await syncExternalCalendarImport(supabase, { integrationId })
}

async function processSyncCalendarExportJob(supabase: SupabaseClient, job: ClaimedJob) {
  const payload = asRecord(job.payload)
  const integrationId = asString(payload.integration_id)
  if (!integrationId) {
    throw new Error('Calendar export job payload is missing integration_id.')
  }

  const sourceKind = asString(payload.source_kind).toLowerCase()
  const itemId = asString(payload.item_id)
  const action = asString(payload.action).toUpperCase() === 'DELETE' ? 'DELETE' : 'UPSERT'
  const fullSync = String(payload.full_sync ?? '').trim() === 'true' || payload.full_sync === true

  const ref =
    !fullSync && itemId && ['calendar', 'task', 'case_court'].includes(sourceKind)
      ? ({
          sourceKind: sourceKind as CalendarItemRef['sourceKind'],
          itemId,
        } satisfies CalendarItemRef)
      : null

  await syncExternalCalendarExport(supabase, {
    integrationId,
    ref,
    action,
  })
}

async function processClaimedJob(supabase: SupabaseClient, job: ClaimedJob) {
  switch (job.job_type) {
    case 'OCR_PROCESS_DOCUMENT':
      await processOcrProcessDocumentJob(supabase, job)
      return
    case 'DELIVER_EVENT_REMINDER':
      await processDeliverEventReminderJob(supabase, job)
      return
    case 'SYNC_CALENDAR_IMPORT':
      await processSyncCalendarImportJob(supabase, job)
      return
    case 'SYNC_CALENDAR_EXPORT':
      await processSyncCalendarExportJob(supabase, job)
      return
    case 'REMIND_COURT_DATE':
    case 'REMIND_CLIENT_DOCS':
    case 'NUDGE_ATTORNEY_UPDATE':
    case 'ESCALATE_UNACCEPTED_OFFER':
      await processSlaReminderJob(supabase, job)
      return
    default:
      throw new Error(`Unsupported job type: ${job.job_type}`)
  }
}

async function completeJob(
  supabase: SupabaseClient,
  params: { jobId: string; succeeded: boolean; error?: string }
) {
  const rpc = await supabase.rpc('complete_job', {
    p_job_id: params.jobId,
    p_succeeded: params.succeeded,
    p_error: params.error || null,
  })

  if (rpc.error) {
    throw new Error(rpc.error.message)
  }

  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as CompleteJobRpcRow | null
  if (!row || !row.final_status) {
    throw new Error('complete_job did not return a status row.')
  }

  return row
}

export async function runWorkerBatch(params?: {
  limit?: number
  jobTypes?: string[] | null
  workerId?: string
}) {
  const supabase = createServiceRoleClient()
  await enqueuePastCourtAttorneyUpdateRequests(supabase)
  const workerId = resolveWorkerId(params?.workerId)
  const limit = Math.max(1, Math.min(params?.limit ?? DEFAULT_BATCH_LIMIT, MAX_BATCH_LIMIT))
  const jobTypes = (params?.jobTypes ?? [])
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean)

  const claim = await supabase.rpc('claim_jobs', {
    p_worker_id: workerId,
    p_limit: limit,
    p_job_types: jobTypes.length ? jobTypes : null,
  })

  if (claim.error) {
    throw new Error(claim.error.message)
  }

  const jobs = (Array.isArray(claim.data) ? claim.data : []) as ClaimedJob[]
  const summary: WorkerBatchResult = {
    claimed: jobs.length,
    succeeded: 0,
    retried: 0,
    dead: 0,
    failed: 0,
    jobs: [],
  }

  for (const job of jobs) {
    const payload = asRecord(job.payload)
    const caseId = asString(job.case_id) || asString(payload.case_id)
    const startedAt = new Date().toISOString()

    let runId = ''
    const runInsert = await supabase
      .from('job_runs')
      .insert({
        job_id: job.id,
        attempt_number: job.attempts,
        worker_id: workerId,
        status: 'RUNNING',
        started_at: startedAt,
        metadata: {
          job_type: job.job_type,
          case_id: caseId || null,
        },
      })
      .select('id')
      .single<{ id: string }>()

    if (runInsert.error || !runInsert.data?.id) {
      throw new Error(runInsert.error?.message || `Could not write job_runs row for ${job.id}`)
    }
    runId = runInsert.data.id

    if (caseId) {
      await writeCaseEvent(supabase, {
        caseId,
        eventType: 'AUTOMATION_JOB_STARTED',
        eventSummary: `Automation job started: ${job.job_type}.`,
        metadata: {
          job_id: job.id,
          attempt: job.attempts,
          worker_id: workerId,
        },
      })
    }

    try {
      await processClaimedJob(supabase, job)
      const completion = await completeJob(supabase, {
        jobId: job.id,
        succeeded: true,
      })

      const finish = await supabase
        .from('job_runs')
        .update({
          status: 'SUCCEEDED',
          finished_at: new Date().toISOString(),
          error_text: null,
        })
        .eq('id', runId)

      if (finish.error) {
        throw new Error(finish.error.message)
      }

      if (caseId) {
        await writeCaseEvent(supabase, {
          caseId,
          eventType: 'AUTOMATION_JOB_SUCCEEDED',
          eventSummary: `Automation job succeeded: ${job.job_type}.`,
          metadata: {
            job_id: job.id,
            final_status: completion.final_status,
          },
        })
      }

      summary.succeeded += 1
      summary.jobs.push({
        jobId: job.id,
        jobType: job.job_type,
        status: 'SUCCEEDED',
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown worker error.'
      let finalStatus: WorkerJobResult['status'] = 'FAILED'
      let nextRunAfter: string | null = null

      try {
        const completion = await completeJob(supabase, {
          jobId: job.id,
          succeeded: false,
          error: message,
        })

        nextRunAfter = completion.next_run_after
        if (completion.final_status === 'RETRY') finalStatus = 'RETRY'
        else if (completion.final_status === 'DEAD') finalStatus = 'DEAD'
      } catch {
        finalStatus = 'FAILED'
      }

      const finish = await supabase
        .from('job_runs')
        .update({
          status: finalStatus,
          finished_at: new Date().toISOString(),
          error_text: message,
        })
        .eq('id', runId)
      if (finish.error) {
        throw new Error(finish.error.message)
      }

      if (caseId) {
        await writeCaseEvent(supabase, {
          caseId,
          eventType: finalStatus === 'DEAD' ? 'AUTOMATION_JOB_DEAD' : 'AUTOMATION_JOB_FAILED',
          eventSummary:
            finalStatus === 'DEAD'
              ? `Automation job dead-lettered: ${job.job_type}.`
              : `Automation job failed: ${job.job_type}.`,
          metadata: {
            job_id: job.id,
            final_status: finalStatus,
            next_run_after: nextRunAfter,
            error: message,
          },
        })
      }

      if (finalStatus === 'RETRY') summary.retried += 1
      else if (finalStatus === 'DEAD') summary.dead += 1
      else summary.failed += 1

      summary.jobs.push({
        jobId: job.id,
        jobType: job.job_type,
        status: finalStatus,
        error: message,
      })
    }
  }

  return summary
}
