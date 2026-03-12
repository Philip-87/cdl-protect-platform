import type { SupabaseClient } from '@supabase/supabase-js'
import { getCalendarEventTypeMeta } from '@/app/attorney/calendar/config'
import { getOptionalServiceRoleClient } from '@/app/lib/server/optional-service-role'
import { getAppBaseUrl } from '@/app/lib/server/stripe'

type JsonRecord = Record<string, unknown>

export type CalendarItemRef = {
  sourceKind: 'calendar' | 'task' | 'case_court'
  itemId: string
}

export type CalendarPlatformItem = {
  sourceKind: CalendarItemRef['sourceKind']
  itemId: string
  platformEventKey: string
  caseId: string | null
  ownerUserId: string | null
  assignedUserId: string | null
  title: string
  eventType: string
  startAt: string
  endAt: string
  allDay: boolean
  location: string | null
  meetingUrl: string | null
  referenceLink: string | null
  notes: string | null
  visibility: 'PRIVATE' | 'SHARED'
  status: string
  linkedCourt: string | null
  linkedState: string | null
  linkedCounty: string | null
  reminderOffsets: number[]
  prepBeforeMinutes: number
  travelBeforeMinutes: number
  travelAfterMinutes: number
  citationNumber: string | null
  metadata: JsonRecord
}

export type AttorneyCalendarIntegrationRow = {
  id: string
  user_id: string
  provider: 'GOOGLE' | 'MICROSOFT'
  provider_account_email: string | null
  provider_calendar_id: string
  access_token_encrypted: string
  refresh_token_encrypted: string | null
  token_expires_at: string | null
  granted_scopes: string[] | null
  sync_enabled: boolean
  import_external_events: boolean
  export_platform_events: boolean
  sync_direction: 'BIDIRECTIONAL' | 'IMPORT_ONLY' | 'EXPORT_ONLY'
  last_sync_at: string | null
  last_sync_status: 'CONNECTED' | 'PENDING' | 'ERROR' | 'DISCONNECTED'
  last_sync_error: string | null
  metadata: JsonRecord | null
}

function getMetadataRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function normalizeReminderOffsets(raw: unknown, fallback: readonly number[]) {
  if (Array.isArray(raw)) {
    const values = raw
      .map((value) => Number.parseInt(String(value ?? ''), 10))
      .filter((value) => Number.isFinite(value) && value >= 0)
    return values.length ? [...new Set(values)] : [...fallback]
  }
  return [...fallback]
}

function mapTaskEventType(taskType: string, metadata: JsonRecord) {
  const direct = String(metadata['event_type'] ?? '').trim().toUpperCase()
  if (direct) return direct
  return String(taskType).trim().toUpperCase() === 'ATTORNEY_REMINDER' ? 'REMINDER' : 'ADMIN_TASK'
}

function mapTaskStatus(status: string) {
  const normalized = String(status ?? '').trim().toUpperCase()
  if (normalized === 'DONE') return 'COMPLETED'
  if (normalized === 'CANCELLED') return 'CANCELLED'
  if (normalized === 'PENDING') return 'TENTATIVE'
  return 'SCHEDULED'
}

function buildCaseCourtTitle(input: {
  courtName: string | null
  county: string | null
  citationNumber: string | null
}) {
  const court = String(input.courtName ?? '').trim()
  if (court) return court
  const county = String(input.county ?? '').trim()
  if (county) return `${county} court appearance`
  if (input.citationNumber) return `Court appearance - ${input.citationNumber}`
  return 'Court appearance'
}

function toTimeFieldValue(value: string | null | undefined) {
  return String(value ?? '').trim().slice(0, 5)
}

function combineCaseCourtDate(date: string | null | undefined, time: string | null | undefined) {
  const day = String(date ?? '').trim()
  if (!day) return null
  const safeTime = toTimeFieldValue(time) || '09:00'
  const start = new Date(`${day}T${safeTime}:00`)
  if (Number.isNaN(+start)) return null
  return start
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000)
}

export function platformEventKey(ref: CalendarItemRef) {
  return `${ref.sourceKind}:${ref.itemId}`
}

export async function loadCalendarPlatformItem(
  supabase: Pick<SupabaseClient, 'from'>,
  ref: CalendarItemRef
): Promise<CalendarPlatformItem | null> {
  if (ref.sourceKind === 'calendar') {
    const eventRes = await supabase
      .from('attorney_calendar_events')
      .select(
        'id, case_id, owner_user_id, assigned_user_id, title, event_type, start_at, end_at, all_day, location, virtual_meeting_url, visibility, status, notes, linked_court, linked_state, linked_county, prep_before_minutes, travel_before_minutes, travel_after_minutes, reminder_offsets, metadata'
      )
      .eq('id', ref.itemId)
      .maybeSingle<{
        id: string
        case_id: string | null
        owner_user_id: string
        assigned_user_id: string | null
        title: string
        event_type: string
        start_at: string
        end_at: string
        all_day: boolean
        location: string | null
        virtual_meeting_url: string | null
        visibility: 'PRIVATE' | 'SHARED'
        status: string
        notes: string | null
        linked_court: string | null
        linked_state: string | null
        linked_county: string | null
        prep_before_minutes: number
        travel_before_minutes: number
        travel_after_minutes: number
        reminder_offsets: unknown
        metadata: JsonRecord | null
      }>()

    if (eventRes.error || !eventRes.data) return null
    const metadata = getMetadataRecord(eventRes.data.metadata)
    const meta = getCalendarEventTypeMeta(eventRes.data.event_type)

    return {
      sourceKind: 'calendar',
      itemId: eventRes.data.id,
      platformEventKey: platformEventKey(ref),
      caseId: eventRes.data.case_id,
      ownerUserId: eventRes.data.owner_user_id,
      assignedUserId: eventRes.data.assigned_user_id,
      title: eventRes.data.title,
      eventType: eventRes.data.event_type,
      startAt: eventRes.data.start_at,
      endAt: eventRes.data.end_at,
      allDay: eventRes.data.all_day,
      location: eventRes.data.location,
      meetingUrl: eventRes.data.virtual_meeting_url,
      referenceLink: String(metadata['reference_link'] ?? '').trim() || null,
      notes: eventRes.data.notes,
      visibility: eventRes.data.visibility,
      status: eventRes.data.status,
      linkedCourt: eventRes.data.linked_court,
      linkedState: eventRes.data.linked_state,
      linkedCounty: eventRes.data.linked_county,
      reminderOffsets: normalizeReminderOffsets(eventRes.data.reminder_offsets, meta.defaultReminderOffsets),
      prepBeforeMinutes: eventRes.data.prep_before_minutes ?? 0,
      travelBeforeMinutes: eventRes.data.travel_before_minutes ?? 0,
      travelAfterMinutes: eventRes.data.travel_after_minutes ?? 0,
      citationNumber: String(metadata['citation_number'] ?? '').trim() || null,
      metadata,
    }
  }

  if (ref.sourceKind === 'task') {
    const taskRes = await supabase
      .from('case_tasks')
      .select('id, case_id, task_type, requested_by_user_id, target_user_id, instructions, status, due_at, metadata')
      .eq('id', ref.itemId)
      .maybeSingle<{
        id: string
        case_id: string
        task_type: string
        requested_by_user_id: string | null
        target_user_id: string | null
        instructions: string | null
        status: string
        due_at: string | null
        metadata: JsonRecord | null
      }>()

    if (taskRes.error || !taskRes.data?.due_at) return null
    const metadata = getMetadataRecord(taskRes.data.metadata)
    const eventType = mapTaskEventType(taskRes.data.task_type, metadata)
    const meta = getCalendarEventTypeMeta(eventType)
    const startAt = taskRes.data.due_at
    const endAt =
      String(metadata['end_at'] ?? '').trim() ||
      addMinutes(new Date(startAt), meta.defaultDuration).toISOString()

    return {
      sourceKind: 'task',
      itemId: taskRes.data.id,
      platformEventKey: platformEventKey(ref),
      caseId: taskRes.data.case_id,
      ownerUserId: taskRes.data.requested_by_user_id,
      assignedUserId: taskRes.data.target_user_id ?? taskRes.data.requested_by_user_id,
      title: String(taskRes.data.instructions ?? meta.label).trim() || meta.label,
      eventType,
      startAt,
      endAt,
      allDay: Boolean(metadata['all_day']),
      location: String(metadata['location'] ?? '').trim() || null,
      meetingUrl: String(metadata['meeting_url'] ?? '').trim() || null,
      referenceLink: String(metadata['reference_link'] ?? '').trim() || null,
      notes: String(metadata['notes'] ?? '').trim() || null,
      visibility:
        String(metadata['visibility'] ?? 'SHARED').trim().toUpperCase() === 'PRIVATE'
          ? 'PRIVATE'
          : 'SHARED',
      status: mapTaskStatus(taskRes.data.status),
      linkedCourt: String(metadata['linked_court'] ?? '').trim() || null,
      linkedState: String(metadata['linked_state'] ?? '').trim() || null,
      linkedCounty: String(metadata['linked_county'] ?? '').trim() || null,
      reminderOffsets: normalizeReminderOffsets(metadata['reminder_offsets'], meta.defaultReminderOffsets),
      prepBeforeMinutes: Number(metadata['prep_before_minutes'] ?? 0) || 0,
      travelBeforeMinutes: Number(metadata['travel_before_minutes'] ?? 0) || 0,
      travelAfterMinutes: Number(metadata['travel_after_minutes'] ?? 0) || 0,
      citationNumber: String(metadata['citation_number'] ?? '').trim() || null,
      metadata,
    }
  }

  const caseRes = await supabase
    .from('cases')
    .select(
      'id, citation_number, state, county, court_name, court_address, court_date, court_time, status, assigned_attorney_user_id, metadata'
    )
    .eq('id', ref.itemId)
    .maybeSingle<{
      id: string
      citation_number: string | null
      state: string
      county: string | null
      court_name: string | null
      court_address: string | null
      court_date: string | null
      court_time: string | null
      status: string
      assigned_attorney_user_id: string | null
      metadata: JsonRecord | null
    }>()

  if (caseRes.error || !caseRes.data?.court_date) return null
  const start = combineCaseCourtDate(caseRes.data.court_date, caseRes.data.court_time)
  if (!start) return null
  const metadata = getMetadataRecord(caseRes.data.metadata)
  const meta = getCalendarEventTypeMeta('COURT_APPEARANCE')
  const reminderDefaults = normalizeReminderOffsets(
    metadata['calendar_reminder_offsets'],
    meta.defaultReminderOffsets
  )

  return {
    sourceKind: 'case_court',
    itemId: caseRes.data.id,
    platformEventKey: platformEventKey(ref),
    caseId: caseRes.data.id,
    ownerUserId: caseRes.data.assigned_attorney_user_id,
    assignedUserId: caseRes.data.assigned_attorney_user_id,
    title: buildCaseCourtTitle({
      courtName: caseRes.data.court_name,
      county: caseRes.data.county,
      citationNumber: caseRes.data.citation_number,
    }),
    eventType: 'COURT_APPEARANCE',
    startAt: start.toISOString(),
    endAt: addMinutes(start, meta.defaultDuration).toISOString(),
    allDay: false,
    location: caseRes.data.court_address,
    meetingUrl: null,
    referenceLink: null,
    notes: null,
    visibility: 'SHARED',
    status: String(caseRes.data.status ?? '').trim().toUpperCase() === 'CLOSED' ? 'COMPLETED' : 'SCHEDULED',
    linkedCourt: caseRes.data.court_name,
    linkedState: caseRes.data.state,
    linkedCounty: caseRes.data.county,
    reminderOffsets: reminderDefaults,
    prepBeforeMinutes: 30,
    travelBeforeMinutes: 20,
    travelAfterMinutes: 20,
    citationNumber: caseRes.data.citation_number,
    metadata,
  }
}

export async function loadCalendarIntegrationsForUser(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string
) {
  const integrationsRes = await supabase
    .from('attorney_calendar_integrations')
    .select(
      'id, user_id, provider, provider_account_email, provider_calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, granted_scopes, sync_enabled, import_external_events, export_platform_events, sync_direction, last_sync_at, last_sync_status, last_sync_error, metadata'
    )
    .eq('user_id', userId)
    .order('provider', { ascending: true })

  if (integrationsRes.error) {
    if (/does not exist|schema cache/i.test(integrationsRes.error.message)) {
      return { data: [] as AttorneyCalendarIntegrationRow[], missing: true, error: '' }
    }
    return { data: [] as AttorneyCalendarIntegrationRow[], missing: false, error: integrationsRes.error.message }
  }

  return {
    data: (integrationsRes.data ?? []) as AttorneyCalendarIntegrationRow[],
    missing: false,
    error: '',
  }
}

export async function rescheduleReminderJobsForCalendarItem(ref: CalendarItemRef) {
  const service = getOptionalServiceRoleClient()
  if (!service) return

  const dedupePrefix = `DELIVER_EVENT_REMINDER:${platformEventKey(ref)}:`
  await service
    .from('job_queue')
    .update({
      status: 'DEAD',
      dead_lettered_at: new Date().toISOString(),
      last_error: 'Superseded by calendar update.',
      updated_at: new Date().toISOString(),
    })
    .like('dedupe_key', `${dedupePrefix}%`)
    .in('status', ['PENDING', 'RETRY'])

  const item = await loadCalendarPlatformItem(service, ref)
  if (!item) return

  const targetUserId = item.assignedUserId || item.ownerUserId
  if (!targetUserId) return
  if (['COMPLETED', 'CANCELLED', 'DONE'].includes(String(item.status ?? '').trim().toUpperCase())) return

  const startAt = new Date(item.startAt)
  if (Number.isNaN(+startAt)) return
  if (+startAt <= Date.now()) return

  const reminderOffsets = [...new Set(item.reminderOffsets.filter((value) => Number.isFinite(value) && value >= 0))]
  for (const offsetMinutes of reminderOffsets) {
    const targetRun = new Date(startAt.getTime() - offsetMinutes * 60000)
    const runAfter = targetRun > new Date() ? targetRun : new Date(Date.now() + 5000)

    await service.rpc('enqueue_case_job', {
      p_job_type: 'DELIVER_EVENT_REMINDER',
      p_case_id: item.caseId,
      p_payload: {
        source_kind: item.sourceKind,
        item_id: item.itemId,
        platform_event_key: item.platformEventKey,
        target_user_id: targetUserId,
        offset_minutes: offsetMinutes,
      },
      p_run_after: runAfter.toISOString(),
      p_priority: 15,
      p_max_attempts: 5,
      p_dedupe_key: `${dedupePrefix}${offsetMinutes}`,
    })
  }
}

export async function queueCalendarExportSyncForItem(params: {
  userId: string
  ref: CalendarItemRef
  action?: 'UPSERT' | 'DELETE'
}) {
  const service = getOptionalServiceRoleClient()
  if (!service) return

  const integrations = await loadCalendarIntegrationsForUser(service, params.userId)
  if (!integrations.data.length) return

  for (const integration of integrations.data) {
    if (!integration.sync_enabled || !integration.export_platform_events) continue
    if (integration.sync_direction === 'IMPORT_ONLY') continue

    await service.rpc('enqueue_case_job', {
      p_job_type: 'SYNC_CALENDAR_EXPORT',
      p_case_id: null,
      p_payload: {
        integration_id: integration.id,
        source_kind: params.ref.sourceKind,
        item_id: params.ref.itemId,
        action: params.action ?? 'UPSERT',
      },
      p_priority: 30,
      p_max_attempts: 5,
      p_dedupe_key: `SYNC_CALENDAR_EXPORT:${integration.id}:${platformEventKey(params.ref)}:${params.action ?? 'UPSERT'}`,
    })
  }
}

export async function queueCalendarFullSyncForIntegration(params: {
  integrationId: string
  caseId?: string | null
}) {
  const service = getOptionalServiceRoleClient()
  if (!service) return

  await service.rpc('enqueue_case_job', {
    p_job_type: 'SYNC_CALENDAR_IMPORT',
    p_case_id: params.caseId ?? null,
    p_payload: {
      integration_id: params.integrationId,
    },
    p_priority: 40,
    p_max_attempts: 5,
    p_dedupe_key: `SYNC_CALENDAR_IMPORT:${params.integrationId}`,
  })

  await service.rpc('enqueue_case_job', {
    p_job_type: 'SYNC_CALENDAR_EXPORT',
    p_case_id: params.caseId ?? null,
    p_payload: {
      integration_id: params.integrationId,
      full_sync: true,
      action: 'UPSERT',
    },
    p_priority: 45,
    p_max_attempts: 5,
    p_dedupe_key: `SYNC_CALENDAR_EXPORT:${params.integrationId}:FULL`,
  })
}

export function buildCalendarItemHref(item: Pick<CalendarPlatformItem, 'caseId' | 'startAt'>) {
  const baseUrl = getAppBaseUrl()
  if (item.caseId) {
    const relative = `/cases/${item.caseId}?return_to=${encodeURIComponent('/attorney/calendar')}`
    return baseUrl ? `${baseUrl}${relative}` : relative
  }

  const date = String(item.startAt ?? '').slice(0, 10)
  const relative = `/attorney/calendar?date=${encodeURIComponent(date)}`
  if (!baseUrl) return relative
  return `${baseUrl}${relative}`
}
