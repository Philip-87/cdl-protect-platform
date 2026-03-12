import Link from 'next/link'
import { AttorneyWorkspaceLayout } from '@/app/attorney/components/AttorneyWorkspaceLayout'
import { AttorneyCalendarWorkspace } from '@/app/attorney/calendar/AttorneyCalendarWorkspace'
import { getCalendarEventTypeMeta, isCalendarView, type AttorneyCalendarView } from '@/app/attorney/calendar/config'
import type {
  AttorneyCalendarItem,
  CalendarCaseOption,
  CalendarConnectionSummary,
  CalendarFirmMember,
  CalendarPreferences,
} from '@/app/attorney/calendar/types'
import { requireAttorneyFeature, requireAttorneyViewer } from '@/app/attorney/lib/server'
import { getAttorneyWorkspaceSummary } from '@/app/attorney/lib/workspace'
import {
  getCaseDisplayDriverName,
  getCaseMetadataRecord,
} from '@/app/lib/cases/display'
import { getCalendarIntegrationOverview } from '@/app/lib/server/calendar-sync'
import { hydrateCaseDriverNames } from '@/app/lib/server/case-driver-display'
import { getFleetRowsByIds } from '@/app/lib/server/fleet-access'

type CaseRow = {
  id: string
  citation_number: string | null
  state: string
  county: string | null
  court_name: string | null
  court_address: string | null
  court_date: string | null
  court_time: string | null
  status: string
  fleet_id: string | null
  driver_id?: string | null
  assigned_attorney_user_id?: string | null
  metadata?: Record<string, unknown> | null
  updated_at: string
  created_at: string
}

type TaskRow = {
  id: string
  case_id: string
  task_type: string
  requested_by_user_id: string | null
  target_user_id: string | null
  instructions: string | null
  status: string
  due_at: string | null
  metadata: Record<string, unknown> | null
}

type CalendarEventRow = {
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
  recurrence_rule: Record<string, unknown> | null
  metadata: Record<string, unknown> | null
}

type AttorneyProfile = {
  metadata: Record<string, unknown> | null
  full_name?: string | null
  email?: string | null
  phone?: string | null
  state?: string | null
  office_address?: string | null
  zip_code?: string | null
  counties?: unknown
  coverage_states?: unknown
  fee_mode?: string | null
  cdl_flat_fee?: number | null
  non_cdl_flat_fee?: number | null
  agreed_to_terms?: boolean | null
  signature_text?: string | null
}

const DEFAULT_CALENDAR_PREFERENCES: CalendarPreferences = {
  timezone: 'America/Chicago',
  workingHours: {
    sun: { enabled: false, start: '09:00', end: '12:00' },
    mon: { enabled: true, start: '08:00', end: '17:00' },
    tue: { enabled: true, start: '08:00', end: '17:00' },
    wed: { enabled: true, start: '08:00', end: '17:00' },
    thu: { enabled: true, start: '08:00', end: '17:00' },
    fri: { enabled: true, start: '08:00', end: '17:00' },
    sat: { enabled: false, start: '09:00', end: '12:00' },
  },
  hearingDurationMinutes: 60,
  prepBufferMinutes: 30,
  travelBufferMinutes: 20,
  reminderDefaults: [1440, 120],
  noticeWindowDays: 7,
}

function parseDateToken(value: string | undefined) {
  const now = new Date()
  const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return new Date(now.getFullYear(), now.getMonth(), now.getDate())
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function endOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 59, 999)
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function getMetadataRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function normalizeReminderOffsets(raw: unknown, fallback: readonly number[]) {
  if (Array.isArray(raw)) {
    const offsets = raw
      .map((value) => Number.parseInt(String(value ?? ''), 10))
      .filter((value) => Number.isFinite(value) && value >= 0)
    return offsets.length ? offsets : [...fallback]
  }
  return [...fallback]
}

function normalizeCalendarPreferences(raw: unknown): CalendarPreferences {
  const source = getMetadataRecord(raw)
  const workingHoursSource = getMetadataRecord(source['working_hours'])
  const workingHours = Object.fromEntries(
    Object.entries(DEFAULT_CALENDAR_PREFERENCES.workingHours).map(([key, defaults]) => {
      const day = getMetadataRecord(workingHoursSource[key])
      return [
        key,
        {
          enabled: typeof day['enabled'] === 'boolean' ? (day['enabled'] as boolean) : defaults.enabled,
          start: String(day['start'] ?? defaults.start),
          end: String(day['end'] ?? defaults.end),
        },
      ]
    })
  ) as CalendarPreferences['workingHours']

  return {
    timezone: String(source['timezone'] ?? DEFAULT_CALENDAR_PREFERENCES.timezone),
    workingHours,
    hearingDurationMinutes:
      Number.isFinite(Number(source['hearing_duration_minutes'])) && Number(source['hearing_duration_minutes']) > 0
        ? Number(source['hearing_duration_minutes'])
        : DEFAULT_CALENDAR_PREFERENCES.hearingDurationMinutes,
    prepBufferMinutes:
      Number.isFinite(Number(source['prep_buffer_minutes'])) && Number(source['prep_buffer_minutes']) >= 0
        ? Number(source['prep_buffer_minutes'])
        : DEFAULT_CALENDAR_PREFERENCES.prepBufferMinutes,
    travelBufferMinutes:
      Number.isFinite(Number(source['travel_buffer_minutes'])) && Number(source['travel_buffer_minutes']) >= 0
        ? Number(source['travel_buffer_minutes'])
        : DEFAULT_CALENDAR_PREFERENCES.travelBufferMinutes,
    reminderDefaults: normalizeReminderOffsets(source['reminder_defaults'], DEFAULT_CALENDAR_PREFERENCES.reminderDefaults),
    noticeWindowDays:
      Number.isFinite(Number(source['notice_window_days'])) && Number(source['notice_window_days']) > 0
        ? Number(source['notice_window_days'])
        : DEFAULT_CALENDAR_PREFERENCES.noticeWindowDays,
  }
}

function normalizeTaskEventType(task: TaskRow) {
  const metadata = getMetadataRecord(task.metadata)
  const direct = String(metadata['event_type'] ?? '').trim().toUpperCase()
  if (direct) return direct
  return task.task_type === 'ATTORNEY_REMINDER' ? 'REMINDER' : 'ADMIN_TASK'
}

function mapTaskStatus(status: string) {
  const normalized = String(status ?? '').trim().toUpperCase()
  if (normalized === 'DONE') return 'COMPLETED'
  if (normalized === 'CANCELLED') return 'CANCELLED'
  if (normalized === 'PENDING') return 'TENTATIVE'
  return 'SCHEDULED'
}

async function loadFirmMembers(
  supabase: Awaited<ReturnType<typeof requireAttorneyViewer>>['supabase'],
  userId: string,
  displayEmail: string
) {
  const membershipsRes = await supabase
    .from('attorney_firm_memberships')
    .select('firm_id, user_id, role_in_firm')
    .limit(200)

  const membershipRows = (membershipsRes.data ?? []) as Array<{
    firm_id: string
    user_id: string
    role_in_firm: string | null
  }>

  const userIds = [...new Set([userId, ...membershipRows.map((row) => row.user_id).filter(Boolean)])]
  const profileRows: Array<{ id: string; user_id: string | null; full_name: string | null; email: string | null }> = []

  if (userIds.length) {
    const byIdRes = await supabase.from('profiles').select('id, user_id, full_name, email').in('id', userIds)
    profileRows.push(...(((byIdRes.data ?? []) as typeof profileRows) || []))
    const unresolved = userIds.filter((candidate) => !profileRows.some((row) => row.id === candidate || row.user_id === candidate))
    if (unresolved.length) {
      const byUserIdRes = await supabase.from('profiles').select('id, user_id, full_name, email').in('user_id', unresolved)
      profileRows.push(...(((byUserIdRes.data ?? []) as typeof profileRows) || []))
    }
  }

  const profileByUserId = new Map<string, { full_name: string | null; email: string | null }>()
  for (const row of profileRows) {
    if (row.id) profileByUserId.set(row.id, { full_name: row.full_name, email: row.email })
    if (row.user_id) profileByUserId.set(row.user_id, { full_name: row.full_name, email: row.email })
  }

  const members = new Map<string, CalendarFirmMember>()
  for (const row of membershipRows) {
    const profile = profileByUserId.get(row.user_id)
    members.set(row.user_id, {
      userId: row.user_id,
      label: String(profile?.full_name ?? profile?.email ?? row.user_id).trim() || row.user_id,
      email: profile?.email ?? null,
      roleInFirm: row.role_in_firm,
      isCurrentUser: row.user_id === userId,
    })
  }

  if (!members.has(userId)) {
    const profile = profileByUserId.get(userId)
    members.set(userId, {
      userId,
      label: String(profile?.full_name ?? profile?.email ?? displayEmail ?? userId).trim(),
      email: profile?.email ?? null,
      roleInFirm: 'attorney',
      isCurrentUser: true,
    })
  }

  return [...members.values()].sort((left, right) => {
    if (left.isCurrentUser) return -1
    if (right.isCurrentUser) return 1
    return left.label.localeCompare(right.label)
  })
}

export default async function AttorneyCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string; view?: string; date?: string; case?: string }>
}) {
  const params = await searchParams
  const viewer = await requireAttorneyViewer()
  requireAttorneyFeature(viewer, 'attorney_calendar')
  const { supabase, user, displayEmail } = viewer
  const initialDate = parseDateToken(params?.date)
  const initialDateToken = initialDate.toISOString().slice(0, 10)
  const initialView: AttorneyCalendarView = isCalendarView(params?.view) ? params.view : 'month'
  const initialCaseId = String(params?.case ?? '').trim()

  const rangeStart = addDays(startOfMonth(initialDate), -21)
  const rangeEnd = addDays(endOfMonth(addDays(initialDate, 31)), 35)

  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('full_name, email, phone, state, office_address, zip_code, counties, coverage_states, fee_mode, cdl_flat_fee, non_cdl_flat_fee, agreed_to_terms, signature_text, metadata')
    .eq('user_id', user.id)
    .maybeSingle<AttorneyProfile>()

  const profile = profileRes.data ?? { metadata: {} }
  const metadata = getMetadataRecord(profile.metadata)
  const integrations = getMetadataRecord(metadata['integrations'])
  const calendarPreferences = normalizeCalendarPreferences(metadata['calendar_preferences'])
  const workspaceSummary = getAttorneyWorkspaceSummary(profile)
  const calendarOverview = await getCalendarIntegrationOverview(supabase, user.id)
  const preferredCalendarIntegration = calendarOverview.preferred

  const connectionSummary: CalendarConnectionSummary = {
    emailConnected: workspaceSummary.emailSyncConnected,
    emailLabel: workspaceSummary.emailSyncLabel,
    emailAddress: workspaceSummary.emailSyncAddress,
    calendarConnected: Boolean(preferredCalendarIntegration),
    calendarAddress:
      preferredCalendarIntegration?.provider_account_email ||
      workspaceSummary.calendarSyncAddress,
    calendarProvider: preferredCalendarIntegration?.provider ?? null,
    calendarStatus: preferredCalendarIntegration?.last_sync_status ?? null,
    calendarError: preferredCalendarIntegration?.last_sync_error ?? null,
    lastCalendarSyncAt:
      preferredCalendarIntegration?.last_sync_at ||
      String(integrations['calendar_connected_at'] ?? integrations['google_calendar_connected_at'] ?? '') ||
      null,
  }

  const firmMembers = await loadFirmMembers(supabase, user.id, displayEmail)
  const ownerLabelById = new Map(firmMembers.map((member) => [member.userId, member.label]))

  const casesRes = await supabase
    .from('cases')
    .select('id, citation_number, state, county, court_name, court_address, court_date, court_time, status, fleet_id, driver_id, assigned_attorney_user_id, metadata, updated_at, created_at')
    .order('updated_at', { ascending: false })
    .limit(500)

  const hydratedCases = await hydrateCaseDriverNames(supabase, ((casesRes.data ?? []) as CaseRow[]))
  const fleetIds = [...new Set(hydratedCases.map((row) => row.fleet_id).filter(Boolean) as string[])]
  const fleetRows = await getFleetRowsByIds(supabase, fleetIds, { includeArchived: true })
  const fleetNameById = new Map(fleetRows.map((row) => [row.id, row.company_name]))

  const caseOptions: CalendarCaseOption[] = hydratedCases
    .map((row) => {
      const rowMetadata = getCaseMetadataRecord(row)
      return {
        id: row.id,
        citationNumber: row.citation_number,
        state: row.state,
        county: row.county,
        courtName: row.court_name,
        courtAddress: row.court_address,
        courtDate: row.court_date,
        courtTime: row.court_time,
        driverName: getCaseDisplayDriverName(row),
        fleetName: fleetNameById.get(row.fleet_id ?? '') || String(rowMetadata['fleet_name'] ?? '').trim() || null,
        status: row.status,
      }
    })
    .sort((left, right) => {
      const leftTime = left.courtDate ? +new Date(left.courtDate) : Number.POSITIVE_INFINITY
      const rightTime = right.courtDate ? +new Date(right.courtDate) : Number.POSITIVE_INFINITY
      return leftTime - rightTime
    })

  const caseOptionById = new Map(caseOptions.map((item) => [item.id, item]))

  const tasksRes = await supabase
    .from('case_tasks')
    .select('id, case_id, task_type, requested_by_user_id, target_user_id, instructions, status, due_at, metadata')
    .not('due_at', 'is', null)
    .gte('due_at', rangeStart.toISOString())
    .lte('due_at', rangeEnd.toISOString())
    .order('due_at', { ascending: true })
    .limit(800)

  let calendarStorageAvailable = true
  let calendarNotice = ''
  const calendarEventsRes = await supabase
    .from('attorney_calendar_events')
    .select(
      'id, case_id, owner_user_id, assigned_user_id, title, event_type, start_at, end_at, all_day, location, virtual_meeting_url, visibility, status, notes, linked_court, linked_state, linked_county, prep_before_minutes, travel_before_minutes, travel_after_minutes, reminder_offsets, recurrence_rule, metadata'
    )
    .gte('end_at', rangeStart.toISOString())
    .lte('start_at', rangeEnd.toISOString())
    .order('start_at', { ascending: true })
    .limit(800)

  const calendarEventRows = (() => {
    if (!calendarEventsRes.error) return (calendarEventsRes.data ?? []) as CalendarEventRow[]
    calendarStorageAvailable = false
    calendarNotice =
      /does not exist|schema cache/i.test(calendarEventsRes.error.message)
        ? 'Apply the attorney calendar migration to unlock calendar-only events, team overlays, and reschedule persistence.'
        : `Calendar event storage is unavailable: ${calendarEventsRes.error.message}`
    return [] as CalendarEventRow[]
  })()

  const taskRows = (tasksRes.data ?? []) as TaskRow[]

  const courtItems: AttorneyCalendarItem[] = caseOptions.flatMap((caseOption) => {
    if (!caseOption.courtDate) return []
    const time = caseOption.courtTime || '09:00'
    const startAt = new Date(`${caseOption.courtDate}T${time}:00`)
    if (Number.isNaN(+startAt)) return []
    const endAt = new Date(startAt.getTime() + calendarPreferences.hearingDurationMinutes * 60000)
    return [
      {
        id: `case-court-${caseOption.id}`,
        sourceKind: 'case_court',
        caseId: caseOption.id,
        title: `${caseOption.courtName || `${caseOption.county || 'Court'} appearance`}`,
        eventType: 'COURT_APPEARANCE',
        family: 'hearing',
        colorKey: 'court',
        startAt: startAt.toISOString(),
        endAt: endAt.toISOString(),
        allDay: false,
        location: caseOption.courtAddress,
        meetingUrl: null,
        notes: null,
        status: 'SCHEDULED',
        visibility: 'SHARED',
        ownerUserId: null,
        ownerLabel: ownerLabelById.get(user.id) ?? displayEmail,
        assignedUserId: null,
        reminderOffsets: [...getCalendarEventTypeMeta('COURT_APPEARANCE').defaultReminderOffsets],
        prepBeforeMinutes: calendarPreferences.prepBufferMinutes,
        travelBeforeMinutes: calendarPreferences.travelBufferMinutes,
        travelAfterMinutes: calendarPreferences.travelBufferMinutes,
        linkedCourt: caseOption.courtName,
        linkedState: caseOption.state,
        linkedCounty: caseOption.county,
        citationNumber: caseOption.citationNumber,
        driverName: caseOption.driverName,
        fleetName: caseOption.fleetName,
        caseStatus: caseOption.status,
        metadata: { source: 'case_court' },
      },
    ]
  })

  const taskItems: AttorneyCalendarItem[] = taskRows.flatMap((task) => {
    if (!task.due_at) return []
    const metadataRecord = getMetadataRecord(task.metadata)
    const eventType = normalizeTaskEventType(task)
    const meta = getCalendarEventTypeMeta(eventType)
    const dueAt = new Date(task.due_at)
    if (Number.isNaN(+dueAt)) return []
    const endAt = String(metadataRecord['end_at'] ?? '') || new Date(dueAt.getTime() + meta.defaultDuration * 60000).toISOString()
    const caseOption = caseOptionById.get(task.case_id)
    return [
      {
        id: task.id,
        sourceKind: 'task',
        caseId: task.case_id,
        title: String(task.instructions ?? meta.label).trim() || meta.label,
        eventType,
        family: meta.family,
        colorKey: meta.color,
        startAt: dueAt.toISOString(),
        endAt,
        allDay: Boolean(metadataRecord['all_day']),
        location: String(metadataRecord['location'] ?? '').trim() || null,
        meetingUrl: String(metadataRecord['meeting_url'] ?? '').trim() || null,
        notes: String(metadataRecord['notes'] ?? '').trim() || null,
        status: mapTaskStatus(task.status),
        visibility: String(metadataRecord['visibility'] ?? 'SHARED').trim().toUpperCase() === 'PRIVATE' ? 'PRIVATE' : 'SHARED',
        ownerUserId: task.requested_by_user_id,
        ownerLabel: ownerLabelById.get(task.target_user_id || task.requested_by_user_id || user.id) ?? displayEmail,
        assignedUserId: task.target_user_id,
        reminderOffsets: normalizeReminderOffsets(metadataRecord['reminder_offsets'], meta.defaultReminderOffsets),
        prepBeforeMinutes: Number(metadataRecord['prep_before_minutes'] ?? 0) || 0,
        travelBeforeMinutes: Number(metadataRecord['travel_before_minutes'] ?? 0) || 0,
        travelAfterMinutes: Number(metadataRecord['travel_after_minutes'] ?? 0) || 0,
        linkedCourt: String(metadataRecord['linked_court'] ?? '').trim() || caseOption?.courtName || null,
        linkedState: String(metadataRecord['linked_state'] ?? '').trim() || caseOption?.state || null,
        linkedCounty: String(metadataRecord['linked_county'] ?? '').trim() || caseOption?.county || null,
        citationNumber: caseOption?.citationNumber ?? null,
        driverName: caseOption?.driverName ?? null,
        fleetName: caseOption?.fleetName ?? null,
        caseStatus: caseOption?.status ?? null,
        metadata: metadataRecord,
      },
    ]
  })

  const calendarItems: AttorneyCalendarItem[] = calendarEventRows.map((eventRow) => {
    const caseOption = eventRow.case_id ? caseOptionById.get(eventRow.case_id) : null
    const meta = getCalendarEventTypeMeta(eventRow.event_type)
    return {
      id: eventRow.id,
      sourceKind: 'calendar',
      caseId: eventRow.case_id,
      title: eventRow.title,
      eventType: eventRow.event_type,
      family: meta.family,
      colorKey: meta.color,
      startAt: eventRow.start_at,
      endAt: eventRow.end_at,
      allDay: eventRow.all_day,
      location: eventRow.location,
      meetingUrl: eventRow.virtual_meeting_url,
      notes: eventRow.notes,
      status: eventRow.status,
      visibility: eventRow.visibility,
      ownerUserId: eventRow.owner_user_id,
      ownerLabel: ownerLabelById.get(eventRow.assigned_user_id || eventRow.owner_user_id) ?? displayEmail,
      assignedUserId: eventRow.assigned_user_id,
      reminderOffsets: normalizeReminderOffsets(eventRow.reminder_offsets, meta.defaultReminderOffsets),
      prepBeforeMinutes: eventRow.prep_before_minutes,
      travelBeforeMinutes: eventRow.travel_before_minutes,
      travelAfterMinutes: eventRow.travel_after_minutes,
      linkedCourt: eventRow.linked_court || caseOption?.courtName || null,
      linkedState: eventRow.linked_state || caseOption?.state || null,
      linkedCounty: eventRow.linked_county || caseOption?.county || null,
      citationNumber: caseOption?.citationNumber ?? null,
      driverName: caseOption?.driverName ?? null,
      fleetName: caseOption?.fleetName ?? null,
      caseStatus: caseOption?.status ?? null,
      metadata: {
        ...(eventRow.metadata ?? {}),
        recurrence_rule: eventRow.recurrence_rule,
      },
    }
  })

  const integrationNotice = calendarOverview.missing
    ? 'Apply the calendar sync migration to unlock provider connections, background reminders, and inbox notifications.'
    : calendarOverview.error
      ? `Calendar sync status is unavailable: ${calendarOverview.error}`
      : connectionSummary.calendarError
        ? `Calendar sync error: ${connectionSummary.calendarError}`
        : ''
  const notices = [String(params?.message ?? '').trim(), calendarNotice, integrationNotice].filter(Boolean)

  return (
    <AttorneyWorkspaceLayout
      active="calendar"
      title="Calendar"
      description="Run hearings, deadlines, reminders, travel, and internal legal work from one matter-linked scheduling workspace."
      actions={
        <>
          <Link href="/attorney/integrations" className="button-link secondary">
            Sync Settings
          </Link>
          <Link href="/attorney/tasks" className="button-link secondary">
            Open Tasks
          </Link>
        </>
      }
      statusRail={
        <>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Calendar Sync</span>
            <strong>
              {connectionSummary.calendarConnected
                ? `${connectionSummary.calendarProvider === 'MICROSOFT' ? 'Microsoft' : 'Google'} connected`
                : 'Manual mode'}
            </strong>
            <span>{connectionSummary.calendarAddress || 'No linked calendar'}</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Coverage Ready</span>
            <strong>{workspaceSummary.coverageStateCount} states</strong>
            <span>{workspaceSummary.countyCount} counties configured</span>
          </article>
          <article className="attorney-status-card">
            <span className="attorney-status-label">Profile Completion</span>
            <strong>{workspaceSummary.profileCompletion}%</strong>
            <span>{workspaceSummary.profileCompletion >= 85 ? 'Ready for live routing' : 'Complete profile to improve scheduling defaults'}</span>
          </article>
        </>
      }
    >
      <AttorneyCalendarWorkspace
        items={[...courtItems, ...taskItems, ...calendarItems]}
        cases={caseOptions}
        firmMembers={firmMembers}
        connectionSummary={connectionSummary}
        preferences={calendarPreferences}
        initialView={initialView}
        initialDateToken={initialDateToken}
        initialCaseId={initialCaseId}
        notices={notices}
        calendarStorageAvailable={calendarStorageAvailable}
      />
    </AttorneyWorkspaceLayout>
  )
}
