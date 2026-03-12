'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { getCalendarEventTypeMeta, isTaskLikeCalendarEventType } from '@/app/attorney/calendar/config'
import {
  queueCalendarExportSyncForItem,
  rescheduleReminderJobsForCalendarItem,
} from '@/app/lib/server/attorney-calendar-runtime'
import {
  clearAttorneyCalendarIntegrationMetadata,
  disconnectCalendarIntegration,
  syncExternalCalendarExport,
  syncExternalCalendarImport,
} from '@/app/lib/server/calendar-sync'
import { getEnabledFeaturesForRole, loadRoleFeatureOverrides } from '@/app/lib/server/role-features'
import { createClient } from '@/app/lib/supabase/server'
import { createStripeCheckoutSession, getAppBaseUrl, isStripeConfigured } from '@/app/lib/server/stripe'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'

function getReturnTo(formData: FormData, fallback: string) {
  const raw = String(formData.get('return_to') ?? '').trim()
  if (raw.startsWith('/')) return raw
  return fallback
}

function redirectWithMessage(path: string, message: string): never {
  const sep = path.includes('?') ? '&' : '?'
  redirect(`${path}${sep}message=${encodeURIComponent(message)}`)
}

async function requireAttorneyContext() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?message=Please%20sign%20in.')
  }

  const byId = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', user.id)
    .maybeSingle<{ system_role: string | null }>()
  const byUserId =
    byId.data ||
    (
      await supabase
        .from('profiles')
        .select('system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ system_role: string | null }>()
    ).data
  const role = normalizePlatformRole(byUserId?.system_role)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20role%20required.')
  }
  const featureState = await loadRoleFeatureOverrides(supabase)
  const enabledFeatures = getEnabledFeaturesForRole(role, featureState.overrides)
  return { supabase, user, role, enabledFeatures }
}

function trimValue(formData: FormData, key: string) {
  return String(formData.get(key) ?? '').trim()
}

function trimOrNull(formData: FormData, key: string) {
  const value = trimValue(formData, key)
  return value || null
}

function parseNumberField(formData: FormData, key: string, fallback = 0) {
  const parsed = Number.parseInt(trimValue(formData, key), 10)
  return Number.isFinite(parsed) ? Math.max(0, parsed) : fallback
}

function parseNullablePositiveInt(value: string) {
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseReminderOffsets(raw: string, fallback: readonly number[]) {
  const values = raw
    .split(/[,\s|]+/)
    .map((value) => Number.parseInt(value.trim(), 10))
    .filter((value) => Number.isFinite(value) && value >= 0)

  return values.length ? [...new Set(values)] : [...fallback]
}

function combineCalendarDateTime(date: string, time: string, allDay: boolean, isEnd: boolean) {
  if (!date) return null
  if (allDay) {
    return new Date(`${date}T${isEnd ? '23:59:00' : '00:00:00'}`).toISOString()
  }

  const safeTime = time || (isEnd ? '10:00' : '09:00')
  return new Date(`${date}T${safeTime}:00`).toISOString()
}

function toTimeFieldValue(value: string) {
  return value ? value.slice(0, 5) : ''
}

async function resolveAttorneyFirmId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string
) {
  const membership = await supabase
    .from('attorney_firm_memberships')
    .select('firm_id')
    .eq('user_id', userId)
    .limit(1)
    .maybeSingle<{ firm_id: string }>()

  if (!membership.error && membership.data?.firm_id) return membership.data.firm_id

  const onboarding = await supabase
    .from('attorney_onboarding_profiles')
    .select('firm_id')
    .eq('user_id', userId)
    .maybeSingle<{ firm_id: string | null }>()

  return onboarding.data?.firm_id ?? null
}

function mapCalendarStatusToTaskStatus(status: string) {
  const normalized = status.trim().toUpperCase()
  if (normalized === 'COMPLETED') return 'DONE'
  if (normalized === 'CANCELLED') return 'CANCELLED'
  if (normalized === 'TENTATIVE') return 'PENDING'
  return 'OPEN'
}

function buildCalendarTaskMetadata(input: {
  eventType: string
  startAtIso: string
  endAtIso: string
  allDay: boolean
  location: string | null
  meetingUrl: string | null
  visibility: string
  notes: string | null
  linkedCourt: string | null
  linkedState: string | null
  linkedCounty: string | null
  prepBeforeMinutes: number
  travelBeforeMinutes: number
  travelAfterMinutes: number
  reminderOffsets: number[]
  source: string
  recurrenceRule: Record<string, unknown> | null
  referenceLink: string | null
}) {
  return {
    source: input.source,
    event_type: input.eventType,
    start_at: input.startAtIso,
    end_at: input.endAtIso,
    all_day: input.allDay,
    location: input.location,
    meeting_url: input.meetingUrl,
    visibility: input.visibility,
    notes: input.notes,
    linked_court: input.linkedCourt,
    linked_state: input.linkedState,
    linked_county: input.linkedCounty,
    prep_before_minutes: input.prepBeforeMinutes,
    travel_before_minutes: input.travelBeforeMinutes,
    travel_after_minutes: input.travelAfterMinutes,
    reminder_offsets: input.reminderOffsets,
    recurrence_rule: input.recurrenceRule,
    reference_link: input.referenceLink,
  }
}

export async function createAttorneyTask(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const title = String(formData.get('title') ?? '').trim()
  const dueAt = String(formData.get('due_at') ?? '').trim()
  const priority = String(formData.get('priority') ?? 'MEDIUM').trim().toUpperCase()
  const returnTo = getReturnTo(formData, '/attorney/tasks')

  if (!caseId || !title) {
    redirectWithMessage(returnTo, 'Case and task title are required.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const dueDateIso = dueAt ? new Date(`${dueAt}T23:59:00`).toISOString() : null

  const insert = await supabase
    .from('case_tasks')
    .insert({
      case_id: caseId,
      task_type: 'ATTORNEY_TASK',
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      target_user_id: user.id,
      instructions: title,
      status: 'OPEN',
      due_at: dueDateIso,
      metadata: {
        priority,
        source: 'ATTORNEY_TASKS_PAGE',
      },
    })
    .select('id')
    .single<{ id: string }>()
  if (insert.error || !insert.data?.id) {
    redirectWithMessage(returnTo, insert.error?.message || 'Could not create task.')
  }

  await supabase.from('case_events').insert({
    case_id: caseId,
    actor_id: user.id,
    event_type: 'TASK_CREATED',
    event_summary: `Task created: ${title}`,
    metadata: { priority, due_at: dueDateIso },
  })

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: insert.data.id })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'task', itemId: insert.data.id },
    action: 'UPSERT',
  })

  revalidatePath('/attorney/tasks')
  revalidatePath('/attorney/dashboard')
  revalidatePath('/attorney/calendar')
  revalidatePath(`/cases/${caseId}`)
  redirectWithMessage(returnTo, 'Task created.')
}

export async function completeAttorneyTask(formData: FormData) {
  const taskId = String(formData.get('task_id') ?? '').trim()
  const caseId = String(formData.get('case_id') ?? '').trim()
  const returnTo = getReturnTo(formData, '/attorney/tasks')
  if (!taskId) {
    redirectWithMessage(returnTo, 'Missing task id.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const update = await supabase
    .from('case_tasks')
    .update({ status: 'DONE', completed_at: new Date().toISOString() })
    .eq('id', taskId)
  if (update.error) {
    redirectWithMessage(returnTo, update.error.message)
  }

  if (caseId) {
    await supabase.from('case_events').insert({
      case_id: caseId,
      actor_id: user.id,
      event_type: 'TASK_COMPLETED',
      event_summary: 'Attorney task marked complete.',
      metadata: { task_id: taskId },
    })
    revalidatePath(`/cases/${caseId}`)
  }

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: taskId })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'task', itemId: taskId },
    action: 'DELETE',
  })

  revalidatePath('/attorney/tasks')
  revalidatePath('/attorney/reminders')
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Task marked complete.')
}

export async function createAttorneyReminder(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const reminderText = String(formData.get('reminder_text') ?? '').trim()
  const remindOn = String(formData.get('remind_on') ?? '').trim()
  const returnTo = getReturnTo(formData, '/attorney/reminders')

  if (!caseId || !reminderText || !remindOn) {
    redirectWithMessage(returnTo, 'Case, reminder text, and reminder date are required.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const dueAtIso = new Date(`${remindOn}T09:00:00`).toISOString()

  const insert = await supabase
    .from('case_tasks')
    .insert({
      case_id: caseId,
      task_type: 'ATTORNEY_REMINDER',
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      target_user_id: user.id,
      instructions: reminderText,
      status: 'OPEN',
      due_at: dueAtIso,
      metadata: { source: 'ATTORNEY_REMINDERS_PAGE', event_type: 'REMINDER' },
    })
    .select('id')
    .single<{ id: string }>()
  if (insert.error || !insert.data?.id) {
    redirectWithMessage(returnTo, insert.error?.message || 'Could not create reminder.')
  }

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: insert.data.id })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'task', itemId: insert.data.id },
    action: 'UPSERT',
  })

  revalidatePath('/attorney/reminders')
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  revalidatePath(`/cases/${caseId}`)
  redirectWithMessage(returnTo, 'Reminder created.')
}

export async function saveAttorneyCalendarPreferences(formData: FormData) {
  const returnTo = getReturnTo(formData, '/attorney/calendar')
  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar')) {
    redirectWithMessage(returnTo, 'Calendar is disabled for this role.')
  }

  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, metadata')
    .eq('user_id', user.id)
    .maybeSingle<{ id: string; metadata: Record<string, unknown> | null }>()

  if (profileRes.error || !profileRes.data) {
    redirectWithMessage(returnTo, 'Complete attorney onboarding before saving calendar availability.')
  }

  const existingMetadata = profileRes.data.metadata ?? {}
  const existingCalendarRaw = existingMetadata['calendar_preferences']
  const existingCalendar =
    existingCalendarRaw && typeof existingCalendarRaw === 'object' && !Array.isArray(existingCalendarRaw)
      ? (existingCalendarRaw as Record<string, unknown>)
      : {}

  const weekdays = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  const workingHours = Object.fromEntries(
    weekdays.map((day) => [
      day,
      {
        enabled: trimValue(formData, `${day}_enabled`) === '1',
        start: trimValue(formData, `${day}_start`) || (day === 'sat' || day === 'sun' ? '09:00' : '08:00'),
        end: trimValue(formData, `${day}_end`) || (day === 'sat' || day === 'sun' ? '12:00' : '17:00'),
      },
    ])
  )

  const nextCalendarPreferences = {
    ...existingCalendar,
    timezone: trimValue(formData, 'timezone') || String(existingCalendar['timezone'] ?? 'America/Chicago'),
    working_hours: workingHours,
    hearing_duration_minutes: parseNumberField(formData, 'hearing_duration_minutes', Number(existingCalendar['hearing_duration_minutes'] ?? 60) || 60),
    prep_buffer_minutes: parseNumberField(formData, 'prep_buffer_minutes', Number(existingCalendar['prep_buffer_minutes'] ?? 30) || 30),
    travel_buffer_minutes: parseNumberField(formData, 'travel_buffer_minutes', Number(existingCalendar['travel_buffer_minutes'] ?? 20) || 20),
    notice_window_days: parseNumberField(formData, 'notice_window_days', Number(existingCalendar['notice_window_days'] ?? 7) || 7),
    reminder_defaults: parseReminderOffsets(
      trimValue(formData, 'reminder_defaults_csv'),
      Array.isArray(existingCalendar['reminder_defaults'])
        ? (existingCalendar['reminder_defaults'] as unknown[])
            .map((value) => Number.parseInt(String(value ?? ''), 10))
            .filter((value) => Number.isFinite(value) && value >= 0)
        : [1440, 120]
    ),
  }

  const nextMetadata = {
    ...existingMetadata,
    calendar_preferences: nextCalendarPreferences,
  }

  const update = await supabase
    .from('attorney_onboarding_profiles')
    .update({ metadata: nextMetadata })
    .eq('id', profileRes.data.id)

  if (update.error) {
    redirectWithMessage(returnTo, update.error.message)
  }

  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Calendar preferences saved.')
}

export async function saveAttorneyCalendarItem(formData: FormData) {
  const returnTo = getReturnTo(formData, '/attorney/calendar')
  const sourceKind = trimValue(formData, 'source_kind').toLowerCase()
  const itemId = trimValue(formData, 'item_id')
  const title = trimValue(formData, 'title')
  const eventType = trimValue(formData, 'event_type').toUpperCase()
  const startDate = trimValue(formData, 'start_date')
  const startTime = trimValue(formData, 'start_time')
  const endDate = trimValue(formData, 'end_date') || startDate
  const endTime = trimValue(formData, 'end_time')
  const allDay = trimValue(formData, 'all_day') === '1'
  const caseId = trimOrNull(formData, 'case_id')
  const location = trimOrNull(formData, 'location')
  const meetingUrl = trimOrNull(formData, 'meeting_url')
  const referenceLink = trimOrNull(formData, 'reference_link')
  const assignedUserId = trimOrNull(formData, 'assigned_user_id')
  const visibility = trimValue(formData, 'visibility').toUpperCase() || 'SHARED'
  const status = trimValue(formData, 'status').toUpperCase() || 'SCHEDULED'
  const notes = trimOrNull(formData, 'notes')
  const linkedCourt = trimOrNull(formData, 'linked_court')
  const linkedState = trimOrNull(formData, 'linked_state')
  const linkedCounty = trimOrNull(formData, 'linked_county')
  const prepBeforeMinutes = parseNumberField(formData, 'prep_before_minutes', 0)
  const travelBeforeMinutes = parseNumberField(formData, 'travel_before_minutes', 0)
  const travelAfterMinutes = parseNumberField(formData, 'travel_after_minutes', 0)
  const reminderOffsets = parseReminderOffsets(trimValue(formData, 'reminder_offsets_csv'), getCalendarEventTypeMeta(eventType).defaultReminderOffsets)
  const syncCaseCourt = trimValue(formData, 'sync_case_court') === '1'
  const recurrenceFrequency = trimValue(formData, 'recurrence_frequency').toUpperCase()
  const recurrenceInterval = parseNullablePositiveInt(trimValue(formData, 'recurrence_interval')) ?? 1
  const recurrenceUntil = trimOrNull(formData, 'recurrence_until')
  const recurrenceCount = parseNullablePositiveInt(trimValue(formData, 'recurrence_count'))
  const recurrenceRule =
    recurrenceFrequency && recurrenceFrequency !== 'NONE'
      ? {
          frequency: recurrenceFrequency,
          interval: recurrenceInterval,
          until: recurrenceUntil || null,
          count: recurrenceCount,
        }
      : null

  if (!title || !eventType || !startDate) {
    redirectWithMessage(returnTo, 'Title, event type, and start date are required.')
  }

  const startAtIso = combineCalendarDateTime(startDate, startTime, allDay, false)
  const endAtIso = combineCalendarDateTime(endDate, endTime || startTime, allDay, true)

  if (!startAtIso || !endAtIso) {
    redirectWithMessage(returnTo, 'Start and end date/time are required.')
  }

  if (new Date(endAtIso) < new Date(startAtIso)) {
    redirectWithMessage(returnTo, 'End time must be after the start time.')
  }

  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar')) {
    redirectWithMessage(returnTo, 'Calendar is disabled for this role.')
  }
  const storageKind = sourceKind === 'case_court'
    ? 'case_court'
    : sourceKind === 'task' || ((!sourceKind || sourceKind === 'task') && isTaskLikeCalendarEventType(eventType) && caseId)
      ? 'task'
      : 'calendar'

  if (storageKind === 'case_court') {
    const resolvedCaseId = caseId || itemId
    if (!resolvedCaseId) {
      redirectWithMessage(returnTo, 'A linked case is required to manage a court date.')
    }

    const update = await supabase
      .from('cases')
      .update({
        court_date: startDate,
        court_time: allDay ? null : toTimeFieldValue(startTime),
        court_name: linkedCourt || null,
        court_address: location,
      })
      .eq('id', resolvedCaseId)

    if (update.error) {
      redirectWithMessage(returnTo, update.error.message)
    }

    await supabase.from('case_events').insert({
      case_id: resolvedCaseId,
      actor_id: user.id,
      event_type: 'COURT_DATE_UPDATED',
      event_summary: `Court schedule updated from calendar: ${title}`,
      metadata: { court_date: startDate, court_time: allDay ? null : toTimeFieldValue(startTime), court_name: linkedCourt || null },
    })

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'case_court', itemId: resolvedCaseId })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'case_court', itemId: resolvedCaseId },
      action: 'UPSERT',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/dashboard')
    revalidatePath(`/cases/${resolvedCaseId}`)
    redirectWithMessage(returnTo, 'Court schedule updated.')
  }

  if (storageKind === 'task') {
    if (!caseId) {
      redirectWithMessage(returnTo, 'Task-like calendar items must be linked to a case.')
    }

    const taskType = ['REMINDER', 'FOLLOW_UP', 'PAYMENT_REMINDER'].includes(eventType) ? 'ATTORNEY_REMINDER' : 'ATTORNEY_TASK'
    const taskPayload = {
      case_id: caseId,
      task_type: taskType,
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      target_user_id: assignedUserId || user.id,
      instructions: title,
      status: mapCalendarStatusToTaskStatus(status),
      due_at: startAtIso,
      metadata: buildCalendarTaskMetadata({
        eventType,
        startAtIso,
        endAtIso,
        allDay,
        location,
        meetingUrl,
        visibility,
        notes,
        linkedCourt,
        linkedState,
        linkedCounty,
        prepBeforeMinutes,
        travelBeforeMinutes,
        travelAfterMinutes,
        reminderOffsets,
        source: 'ATTORNEY_CALENDAR',
        recurrenceRule,
        referenceLink,
      }),
    }

    const taskResult = itemId
      ? await supabase.from('case_tasks').update(taskPayload).eq('id', itemId).select('id').single<{ id: string }>()
      : await supabase.from('case_tasks').insert(taskPayload).select('id').single<{ id: string }>()

    if (taskResult.error || !taskResult.data?.id) {
      redirectWithMessage(returnTo, taskResult.error?.message || 'Could not save the calendar task.')
    }

    await supabase.from('case_events').insert({
      case_id: caseId,
      actor_id: user.id,
      event_type: itemId ? 'TASK_UPDATED' : 'TASK_CREATED',
      event_summary: `${itemId ? 'Task updated' : 'Task created'} from calendar: ${title}`,
      metadata: { event_type: eventType, due_at: startAtIso },
    })

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: taskResult.data.id })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'task', itemId: taskResult.data.id },
      action: 'UPSERT',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/reminders')
    revalidatePath('/attorney/tasks')
    revalidatePath('/attorney/dashboard')
    revalidatePath(`/cases/${caseId}`)
    redirectWithMessage(returnTo, itemId ? 'Calendar task updated.' : 'Calendar task created.')
  }

  const firmId = await resolveAttorneyFirmId(supabase, user.id)
  const eventPayload = {
    firm_id: firmId,
    owner_user_id: user.id,
    assigned_user_id: assignedUserId || user.id,
    case_id: caseId,
    title,
    event_type: eventType,
    start_at: startAtIso,
    end_at: endAtIso,
    all_day: allDay,
    location,
    virtual_meeting_url: meetingUrl,
    visibility,
    status,
    notes,
    linked_court: linkedCourt,
    linked_state: linkedState,
    linked_county: linkedCounty,
    prep_before_minutes: prepBeforeMinutes,
    travel_before_minutes: travelBeforeMinutes,
    travel_after_minutes: travelAfterMinutes,
    reminder_offsets: reminderOffsets,
    recurrence_rule: recurrenceRule,
    metadata: {
      source: 'ATTORNEY_CALENDAR',
      reference_link: referenceLink,
    },
  }

  const eventResult = itemId
    ? await supabase.from('attorney_calendar_events').update(eventPayload).eq('id', itemId).select('id, case_id').single<{ id: string; case_id: string | null }>()
    : await supabase.from('attorney_calendar_events').insert(eventPayload).select('id, case_id').single<{ id: string; case_id: string | null }>()

  if (eventResult.error) {
    redirectWithMessage(returnTo, eventResult.error.message)
  }

  const resolvedCaseId = eventResult.data.case_id ?? caseId

  if (syncCaseCourt && resolvedCaseId && ['COURT_APPEARANCE', 'HEARING'].includes(eventType)) {
    await supabase
      .from('cases')
      .update({
        court_date: startDate,
        court_time: allDay ? null : toTimeFieldValue(startTime),
        court_name: linkedCourt || null,
        court_address: location,
      })
      .eq('id', resolvedCaseId)
  }

  if (resolvedCaseId) {
    await supabase.from('case_events').insert({
      case_id: resolvedCaseId,
      actor_id: user.id,
      event_type: itemId ? 'CALENDAR_EVENT_UPDATED' : 'CALENDAR_EVENT_CREATED',
      event_summary: `${itemId ? 'Calendar event updated' : 'Calendar event created'}: ${title}`,
      metadata: { event_type: eventType, start_at: startAtIso, end_at: endAtIso },
    })
    revalidatePath(`/cases/${resolvedCaseId}`)
  }

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId: eventResult.data.id })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'calendar', itemId: eventResult.data.id },
    action: 'UPSERT',
  })

  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, itemId ? 'Calendar event updated.' : 'Calendar event created.')
}

export async function deleteAttorneyCalendarItem(formData: FormData) {
  const returnTo = getReturnTo(formData, '/attorney/calendar')
  const sourceKind = trimValue(formData, 'source_kind').toLowerCase()
  const itemId = trimValue(formData, 'item_id')
  const caseId = trimOrNull(formData, 'case_id')
  if (!sourceKind || !itemId) {
    redirectWithMessage(returnTo, 'Missing calendar item reference.')
  }

  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar')) {
    redirectWithMessage(returnTo, 'Calendar is disabled for this role.')
  }

  if (sourceKind === 'case_court') {
    const update = await supabase
      .from('cases')
      .update({ court_date: null, court_time: null })
      .eq('id', itemId)

    if (update.error) {
      redirectWithMessage(returnTo, update.error.message)
    }

    await supabase.from('case_events').insert({
      case_id: itemId,
      actor_id: user.id,
      event_type: 'COURT_DATE_CLEARED',
      event_summary: 'Court schedule cleared from calendar.',
      metadata: null,
    })

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'case_court', itemId })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'case_court', itemId },
      action: 'DELETE',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/dashboard')
    revalidatePath(`/cases/${itemId}`)
    redirectWithMessage(returnTo, 'Court schedule cleared.')
  }

  if (sourceKind === 'task') {
    const update = await supabase
      .from('case_tasks')
      .update({ status: 'CANCELLED' })
      .eq('id', itemId)

    if (update.error) {
      redirectWithMessage(returnTo, update.error.message)
    }

    if (caseId) {
      await supabase.from('case_events').insert({
        case_id: caseId,
        actor_id: user.id,
        event_type: 'TASK_CANCELLED',
        event_summary: 'Calendar-linked task cancelled.',
        metadata: { task_id: itemId },
      })
      revalidatePath(`/cases/${caseId}`)
    }

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'task', itemId },
      action: 'DELETE',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/reminders')
    revalidatePath('/attorney/tasks')
    revalidatePath('/attorney/dashboard')
    redirectWithMessage(returnTo, 'Calendar task cancelled.')
  }

  const remove = await supabase.from('attorney_calendar_events').delete().eq('id', itemId)
  if (remove.error) {
    redirectWithMessage(returnTo, remove.error.message)
  }

  if (caseId) {
    await supabase.from('case_events').insert({
      case_id: caseId,
      actor_id: user.id,
      event_type: 'CALENDAR_EVENT_DELETED',
      event_summary: 'Calendar event deleted.',
      metadata: { event_id: itemId },
    })
    revalidatePath(`/cases/${caseId}`)
  }

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'calendar', itemId },
    action: 'DELETE',
  })

  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Calendar event deleted.')
}

export async function duplicateAttorneyCalendarItem(formData: FormData) {
  const returnTo = getReturnTo(formData, '/attorney/calendar')
  const sourceKind = trimValue(formData, 'source_kind').toLowerCase()
  const itemId = trimValue(formData, 'item_id')
  const caseId = trimOrNull(formData, 'case_id')
  if (!sourceKind || !itemId) {
    redirectWithMessage(returnTo, 'Missing calendar item reference.')
  }

  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar')) {
    redirectWithMessage(returnTo, 'Calendar is disabled for this role.')
  }

  if (sourceKind === 'task') {
    const taskRes = await supabase
      .from('case_tasks')
      .select('case_id, task_type, target_user_id, instructions, due_at, metadata')
      .eq('id', itemId)
      .maybeSingle<{
        case_id: string
        task_type: string
        target_user_id: string | null
        instructions: string | null
        due_at: string | null
        metadata: Record<string, unknown> | null
      }>()

    if (taskRes.error || !taskRes.data) {
      redirectWithMessage(returnTo, 'Could not load the task to duplicate.')
    }

    const sourceDue = taskRes.data.due_at ? new Date(taskRes.data.due_at) : new Date()
    sourceDue.setDate(sourceDue.getDate() + 7)
    const insert = await supabase.from('case_tasks').insert({
      case_id: taskRes.data.case_id,
      task_type: taskRes.data.task_type,
      requested_by_user_id: user.id,
      target_role: 'ATTORNEY',
      target_user_id: taskRes.data.target_user_id,
      instructions: `${taskRes.data.instructions || 'Task'} (Copy)`,
      due_at: sourceDue.toISOString(),
      status: 'OPEN',
      metadata: taskRes.data.metadata ?? {},
    }).select('id').single<{ id: string }>()

    if (insert.error || !insert.data?.id) {
      redirectWithMessage(returnTo, insert.error?.message || 'Could not duplicate the calendar task.')
    }

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId: insert.data.id })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'task', itemId: insert.data.id },
      action: 'UPSERT',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/reminders')
    revalidatePath('/attorney/tasks')
    revalidatePath('/attorney/dashboard')
    revalidatePath(`/cases/${taskRes.data.case_id}`)
    redirectWithMessage(returnTo, 'Calendar task duplicated one week forward.')
  }

  if (sourceKind === 'case_court') {
    const caseRes = await supabase
      .from('cases')
      .select('id, attorney_firm_id, court_name, court_address, court_date, court_time, state, county')
      .eq('id', itemId)
      .maybeSingle<{
        id: string
        attorney_firm_id: string | null
        court_name: string | null
        court_address: string | null
        court_date: string | null
        court_time: string | null
        state: string
        county: string | null
      }>()

    if (caseRes.error || !caseRes.data?.court_date) {
      redirectWithMessage(returnTo, 'Could not duplicate the case-linked court date.')
    }

    const start = new Date(`${caseRes.data.court_date}T${caseRes.data.court_time || '09:00'}:00`)
    const end = new Date(start)
    end.setHours(end.getHours() + 1)
    const duplicated = await supabase.from('attorney_calendar_events').insert({
      firm_id: caseRes.data.attorney_firm_id ?? (await resolveAttorneyFirmId(supabase, user.id)),
      owner_user_id: user.id,
      assigned_user_id: user.id,
      case_id: caseRes.data.id,
      title: 'Court Appearance (Copy)',
      event_type: 'COURT_APPEARANCE',
      start_at: start.toISOString(),
      end_at: end.toISOString(),
      all_day: false,
      location: caseRes.data.court_address,
      visibility: 'SHARED',
      status: 'SCHEDULED',
      linked_court: caseRes.data.court_name,
      linked_state: caseRes.data.state,
      linked_county: caseRes.data.county,
      reminder_offsets: [1440, 120],
      metadata: { source: 'ATTORNEY_CALENDAR_DUPLICATE' },
    }).select('id').single<{ id: string }>()

    if (duplicated.error || !duplicated.data?.id) {
      redirectWithMessage(returnTo, duplicated.error?.message || 'Could not duplicate the court event.')
    }

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId: duplicated.data.id })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'calendar', itemId: duplicated.data.id },
      action: 'UPSERT',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/dashboard')
    revalidatePath(`/cases/${caseRes.data.id}`)
    redirectWithMessage(returnTo, 'Court event copied into the calendar workspace.')
  }

  const eventRes = await supabase
    .from('attorney_calendar_events')
    .select(
      'firm_id, case_id, title, event_type, start_at, end_at, all_day, location, virtual_meeting_url, visibility, status, notes, linked_court, linked_state, linked_county, prep_before_minutes, travel_before_minutes, travel_after_minutes, reminder_offsets, recurrence_rule, metadata'
    )
    .eq('id', itemId)
    .maybeSingle<{
      firm_id: string | null
      case_id: string | null
      title: string
      event_type: string
      start_at: string
      end_at: string
      all_day: boolean
      location: string | null
      virtual_meeting_url: string | null
      visibility: string
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
    }>()

  if (eventRes.error || !eventRes.data) {
    redirectWithMessage(returnTo, 'Could not load the calendar event to duplicate.')
  }

  const duplicatedStart = new Date(eventRes.data.start_at)
  const duplicatedEnd = new Date(eventRes.data.end_at)
  duplicatedStart.setDate(duplicatedStart.getDate() + 7)
  duplicatedEnd.setDate(duplicatedEnd.getDate() + 7)

  const insert = await supabase.from('attorney_calendar_events').insert({
    ...eventRes.data,
    owner_user_id: user.id,
    assigned_user_id: user.id,
    title: `${eventRes.data.title} (Copy)`,
    start_at: duplicatedStart.toISOString(),
    end_at: duplicatedEnd.toISOString(),
    metadata: {
      ...(eventRes.data.metadata ?? {}),
      source: 'ATTORNEY_CALENDAR_DUPLICATE',
    },
  }).select('id').single<{ id: string }>()

  if (insert.error || !insert.data?.id) {
    redirectWithMessage(returnTo, insert.error?.message || 'Could not duplicate the calendar event.')
  }

  await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId: insert.data.id })
  await queueCalendarExportSyncForItem({
    userId: user.id,
    ref: { sourceKind: 'calendar', itemId: insert.data.id },
    action: 'UPSERT',
  })

  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  if (caseId) revalidatePath(`/cases/${caseId}`)
  redirectWithMessage(returnTo, 'Calendar event duplicated one week forward.')
}

export async function completeAttorneyCalendarItem(formData: FormData) {
  const returnTo = getReturnTo(formData, '/attorney/calendar')
  const sourceKind = trimValue(formData, 'source_kind').toLowerCase()
  const itemId = trimValue(formData, 'item_id')
  const caseId = trimOrNull(formData, 'case_id')
  if (!sourceKind || !itemId) {
    redirectWithMessage(returnTo, 'Missing calendar item reference.')
  }

  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar')) {
    redirectWithMessage(returnTo, 'Calendar is disabled for this role.')
  }

  if (sourceKind === 'task') {
    const update = await supabase
      .from('case_tasks')
      .update({ status: 'DONE', completed_at: new Date().toISOString() })
      .eq('id', itemId)

    if (update.error) {
      redirectWithMessage(returnTo, update.error.message)
    }

    if (caseId) {
      await supabase.from('case_events').insert({
        case_id: caseId,
        actor_id: user.id,
        event_type: 'TASK_COMPLETED',
        event_summary: 'Calendar-linked task marked complete.',
        metadata: { task_id: itemId },
      })
      revalidatePath(`/cases/${caseId}`)
    }

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'task', itemId })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'task', itemId },
      action: 'DELETE',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/reminders')
    revalidatePath('/attorney/tasks')
    revalidatePath('/attorney/dashboard')
    redirectWithMessage(returnTo, 'Calendar task marked complete.')
  }

  if (sourceKind === 'calendar') {
    const update = await supabase
      .from('attorney_calendar_events')
      .update({ status: 'COMPLETED' })
      .eq('id', itemId)

    if (update.error) {
      redirectWithMessage(returnTo, update.error.message)
    }

    if (caseId) {
      await supabase.from('case_events').insert({
        case_id: caseId,
        actor_id: user.id,
        event_type: 'CALENDAR_EVENT_COMPLETED',
        event_summary: 'Calendar event marked complete.',
        metadata: { event_id: itemId },
      })
      revalidatePath(`/cases/${caseId}`)
    }

    await rescheduleReminderJobsForCalendarItem({ sourceKind: 'calendar', itemId })
    await queueCalendarExportSyncForItem({
      userId: user.id,
      ref: { sourceKind: 'calendar', itemId },
      action: 'DELETE',
    })

    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/dashboard')
    redirectWithMessage(returnTo, 'Calendar event marked complete.')
  }

  redirectWithMessage(returnTo, 'Court events must be updated from the schedule editor.')
}

export async function sendAttorneyCommunication(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const recipientRole = String(formData.get('recipient_role') ?? '').trim().toUpperCase() || null
  const subject = String(formData.get('subject') ?? '').trim()
  const body = String(formData.get('body') ?? '').trim()
  const channel = String(formData.get('channel') ?? 'IN_APP').trim().toUpperCase()
  const returnTo = getReturnTo(formData, '/attorney/communications')

  if (!caseId || !body) {
    redirectWithMessage(returnTo, 'Case and message body are required.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const renderedBody = subject ? `${subject}\n\n${body}` : body
  const insert = await supabase.from('case_messages').insert({
    case_id: caseId,
    sender_user_id: user.id,
    recipient_role: recipientRole,
    body: renderedBody,
  })
  if (insert.error) {
    redirectWithMessage(returnTo, insert.error.message)
  }

  await supabase.from('case_events').insert({
    case_id: caseId,
    actor_id: user.id,
    event_type: 'MESSAGE_SENT',
    event_summary: channel === 'EMAIL' ? 'Case email logged.' : 'Case message sent.',
    metadata: { recipient_role: recipientRole, subject: subject || null, channel },
  })

  revalidatePath('/attorney/communications')
  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, channel === 'EMAIL' ? 'Email logged to case thread.' : 'Message sent.')
}

export async function saveAttorneyIntegrations(formData: FormData) {
  const emailProvider = String(formData.get('email_provider') ?? '').trim()
  const emailAddress = String(formData.get('email_address') ?? '').trim()
  const lawpayMerchantId = String(formData.get('lawpay_merchant_id') ?? '').trim()
  const googleCalendarEmail = String(formData.get('google_calendar_email') ?? '').trim()
  const googleCalendarEnabled = String(formData.get('google_calendar_enabled') ?? '') === '1'
  const returnTo = getReturnTo(formData, '/attorney/integrations')

  const { supabase, user } = await requireAttorneyContext()

  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, metadata')
    .eq('user_id', user.id)
    .maybeSingle<{ id: string; metadata: Record<string, unknown> | null }>()

  if (profileRes.error || !profileRes.data) {
    redirectWithMessage(returnTo, 'Complete onboarding before saving integrations.')
  }

  const metadata = profileRes.data.metadata ?? {}
  const integrationsRaw = metadata['integrations']
  const integrations =
    integrationsRaw && typeof integrationsRaw === 'object' && !Array.isArray(integrationsRaw)
      ? { ...(integrationsRaw as Record<string, unknown>) }
      : {}

  const nextMetadata = {
    ...metadata,
    integrations: {
      ...integrations,
      email_provider: emailProvider || null,
      email_address: emailAddress || null,
      email_connected_at: emailProvider && emailAddress ? new Date().toISOString() : null,
      lawpay_merchant_id: lawpayMerchantId || null,
      lawpay_connected_at: lawpayMerchantId ? new Date().toISOString() : null,
      google_calendar_email: googleCalendarEmail || null,
      google_calendar_enabled: googleCalendarEnabled,
      google_calendar_connected_at:
        googleCalendarEnabled && googleCalendarEmail ? new Date().toISOString() : null,
    },
  }

  const update = await supabase
    .from('attorney_onboarding_profiles')
    .update({ metadata: nextMetadata })
    .eq('id', profileRes.data.id)
  if (update.error) {
    redirectWithMessage(returnTo, update.error.message)
  }

  revalidatePath('/attorney/integrations')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, 'Integration settings saved.')
}

export async function disconnectAttorneyCalendarConnection(formData: FormData) {
  const integrationId = trimValue(formData, 'integration_id')
  const provider = trimValue(formData, 'provider').toUpperCase()
  const returnTo = getReturnTo(formData, '/attorney/integrations')

  if (!integrationId || (provider !== 'GOOGLE' && provider !== 'MICROSOFT')) {
    redirectWithMessage(returnTo, 'Valid calendar integration is required.')
  }

  const { supabase, user, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar_sync')) {
    redirectWithMessage(returnTo, 'Calendar sync is disabled for this role.')
  }

  try {
    await disconnectCalendarIntegration(supabase, {
      userId: user.id,
      integrationId,
    })
    await clearAttorneyCalendarIntegrationMetadata(supabase, {
      userId: user.id,
      provider,
    })
  } catch (error) {
    redirectWithMessage(returnTo, error instanceof Error ? error.message : 'Could not disconnect calendar integration.')
  }

  revalidatePath('/attorney/integrations')
  revalidatePath('/attorney/calendar')
  revalidatePath('/attorney/dashboard')
  redirectWithMessage(returnTo, `${provider === 'GOOGLE' ? 'Google' : 'Microsoft'} Calendar disconnected.`)
}

export async function runAttorneyCalendarSync(formData: FormData) {
  const integrationId = trimValue(formData, 'integration_id')
  const returnTo = getReturnTo(formData, '/attorney/integrations')

  if (!integrationId) {
    redirectWithMessage(returnTo, 'Calendar integration id is required.')
  }

  const { supabase, enabledFeatures } = await requireAttorneyContext()
  if (!enabledFeatures.includes('attorney_calendar_sync')) {
    redirectWithMessage(returnTo, 'Calendar sync is disabled for this role.')
  }

  try {
    const imported = await syncExternalCalendarImport(supabase, { integrationId })
    const exported = await syncExternalCalendarExport(supabase, { integrationId })

    revalidatePath('/attorney/integrations')
    revalidatePath('/attorney/calendar')
    revalidatePath('/attorney/dashboard')
    redirectWithMessage(
      returnTo,
      `Calendar sync completed. Imported ${imported.imported + imported.updated}, exported ${exported.created + exported.updated}, deleted ${exported.deleted}.`
    )
  } catch (error) {
    redirectWithMessage(returnTo, error instanceof Error ? error.message : 'Calendar sync failed.')
  }
}

export async function markAttorneyNotificationRead(formData: FormData) {
  const notificationId = trimValue(formData, 'notification_id')
  const markAll = trimValue(formData, 'mark_all') === '1'
  const returnTo = getReturnTo(formData, '/attorney/reminders#notification-inbox')

  if (!notificationId && !markAll) {
    redirectWithMessage(returnTo, 'Notification id is required.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const readAt = new Date().toISOString()
  const update = markAll
    ? await supabase
        .from('in_app_notifications')
        .update({ read_at: readAt, updated_at: readAt })
        .eq('user_id', user.id)
        .is('read_at', null)
    : await supabase
        .from('in_app_notifications')
        .update({ read_at: readAt, updated_at: readAt })
        .eq('id', notificationId)
        .eq('user_id', user.id)

  if (update.error) {
    redirectWithMessage(returnTo, update.error.message)
  }

  revalidatePath('/attorney/reminders')
  redirectWithMessage(returnTo, markAll ? 'Notifications marked read.' : 'Notification marked read.')
}

export async function createAttorneyBillingRequest(formData: FormData) {
  const caseId = String(formData.get('case_id') ?? '').trim()
  const amount = Number.parseFloat(String(formData.get('amount') ?? '').trim())
  const source = String(formData.get('source') ?? 'DIRECT_CLIENT').trim().toUpperCase()
  const notes = String(formData.get('notes') ?? '').trim()
  const createCheckout = String(formData.get('create_checkout') ?? '') === '1'
  const returnTo = getReturnTo(formData, '/attorney/billing')

  if (!caseId || !Number.isFinite(amount) || amount <= 0) {
    redirectWithMessage(returnTo, 'Case and valid amount are required.')
  }

  const { supabase, user } = await requireAttorneyContext()
  const amountCents = Math.round(amount * 100)
  const payerRole = source === 'CDL_PROTECT' ? 'OPS' : 'DRIVER'

  const insert = await supabase
    .from('payment_requests')
    .insert({
      case_id: caseId,
      requested_by: user.id,
      payer_role: payerRole,
      source,
      amount_cents: amountCents,
      currency: 'usd',
      status: 'OPEN',
      due_at: new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(),
      metadata: { notes: notes || null },
    })
    .select('id')
    .single<{ id: string }>()

  if (insert.error) {
    redirectWithMessage(returnTo, insert.error.message)
  }

  const paymentRequestId = insert.data.id
  let checkoutUrl: string | null = null
  let checkoutError = ''

  if (createCheckout && source === 'DIRECT_CLIENT') {
    if (!isStripeConfigured()) {
      checkoutError = 'Stripe not configured.'
    } else {
      const baseUrl = getAppBaseUrl()
      if (!baseUrl) {
        checkoutError = 'App URL not configured.'
      } else {
        const session = await createStripeCheckoutSession({
          paymentRequestId,
          caseId,
          amountCents,
          currency: 'usd',
          description: `Traffic case payment (${caseId.slice(0, 8)})`,
          successUrl: `${baseUrl}/attorney/billing?message=Checkout%20completed.`,
          cancelUrl: `${baseUrl}/attorney/billing?message=Checkout%20cancelled.`,
        })
        if (session.ok) {
          checkoutUrl = session.url
          await supabase
            .from('payment_requests')
            .update({
              status: 'PENDING_CHECKOUT',
              provider: 'STRIPE',
              provider_checkout_session_id: session.id,
              metadata: { notes: notes || null, checkout_url: session.url },
            })
            .eq('id', paymentRequestId)
        } else {
          checkoutError = session.error
        }
      }
    }
  }

  await supabase.from('case_tasks').insert({
    case_id: caseId,
    task_type: 'PAYMENT_REQUEST',
    requested_by_user_id: user.id,
    target_role: payerRole,
    instructions: `Payment request: $${amount.toFixed(2)}${notes ? ` | ${notes}` : ''}`,
    status: 'OPEN',
    metadata: { payment_request_id: paymentRequestId, checkout_url: checkoutUrl, source },
  })

  await supabase.from('case_messages').insert({
    case_id: caseId,
    sender_user_id: user.id,
    recipient_role: payerRole,
    body: `Payment requested: $${amount.toFixed(2)}${notes ? ` | ${notes}` : ''}${checkoutUrl ? ` | Checkout: ${checkoutUrl}` : ''}`,
  })

  revalidatePath('/attorney/billing')
  revalidatePath('/attorney/dashboard')
  revalidatePath(`/cases/${caseId}`)
  if (checkoutError) {
    redirectWithMessage(returnTo, `Billing request created. ${checkoutError}`)
  }
  redirectWithMessage(returnTo, checkoutUrl ? 'Billing request created with checkout link.' : 'Billing request created.')
}
