'use client'

import Link from 'next/link'
import { type ReactNode, useMemo, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { usePathname } from 'next/navigation'
import {
  CALENDAR_EVENT_TYPE_OPTIONS,
  CALENDAR_VIEW_OPTIONS,
  getCalendarEventTypeMeta,
  type AttorneyCalendarView,
} from '@/app/attorney/calendar/config'
import type {
  AttorneyCalendarItem,
  CalendarCaseOption,
  CalendarConnectionSummary,
  CalendarFirmMember,
  CalendarPreferences,
} from '@/app/attorney/calendar/types'
import {
  completeAttorneyCalendarItem,
  deleteAttorneyCalendarItem,
  duplicateAttorneyCalendarItem,
  saveAttorneyCalendarItem,
  saveAttorneyCalendarPreferences,
} from '@/app/attorney/tools/actions'

type CalendarDraft = {
  sourceKind: 'task' | 'calendar' | 'case_court'
  itemId: string
  caseId: string
  title: string
  eventType: string
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  allDay: boolean
  assignedUserId: string
  visibility: 'PRIVATE' | 'SHARED'
  status: string
  notes: string
  location: string
  meetingUrl: string
  referenceLink: string
  linkedCourt: string
  linkedState: string
  linkedCounty: string
  prepBeforeMinutes: string
  travelBeforeMinutes: string
  travelAfterMinutes: string
  reminderOffsetsCsv: string
  syncCaseCourt: boolean
  recurrenceFrequency: string
  recurrenceInterval: string
  recurrenceUntil: string
  recurrenceCount: string
}

type CalendarWorkspaceProps = {
  items: AttorneyCalendarItem[]
  cases: CalendarCaseOption[]
  firmMembers: CalendarFirmMember[]
  connectionSummary: CalendarConnectionSummary
  preferences: CalendarPreferences
  initialView: AttorneyCalendarView
  initialDateToken: string
  initialCaseId: string
  notices: string[]
  calendarStorageAvailable: boolean
}

type DayGap = {
  start: Date
  end: Date
}

type DayColumnLayout = {
  item: AttorneyCalendarItem
  lane: number
  totalLanes: number
}

function dateToken(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function parseDateToken(value: string) {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return new Date()
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
}

function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate())
}

function addDays(date: Date, days: number) {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function startOfWeek(date: Date) {
  const next = startOfDay(date)
  next.setDate(next.getDate() - next.getDay())
  return next
}

function startOfMonth(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), 1)
}

function isSameDay(left: Date, right: Date) {
  return (
    left.getFullYear() === right.getFullYear() &&
    left.getMonth() === right.getMonth() &&
    left.getDate() === right.getDate()
  )
}

function safeDate(value: string | null | undefined) {
  const date = value ? new Date(value) : null
  return date && !Number.isNaN(+date) ? date : null
}

function formatShortDate(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
}

function formatLongDate(date: Date) {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })
}

function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(+date)) return '-'
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatTime(value: string | null | undefined, allDay = false) {
  if (allDay) return 'All day'
  const date = safeDate(value)
  if (!date) return '-'
  return date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatDurationMinutes(startAt: string, endAt: string, allDay: boolean) {
  if (allDay) return 'All day'
  const start = safeDate(startAt)
  const end = safeDate(endAt)
  if (!start || !end) return '-'
  const minutes = Math.max(15, Math.round((+end - +start) / 60000))
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours && remainder) return `${hours}h ${remainder}m`
  if (hours) return `${hours}h`
  return `${remainder}m`
}

function toInputDate(value: string) {
  const date = safeDate(value)
  return date ? dateToken(date) : ''
}

function toInputTime(value: string, allDay = false) {
  if (allDay) return ''
  const date = safeDate(value)
  if (!date) return ''
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function minutesFromMidnight(value: string) {
  const date = safeDate(value)
  if (!date) return 0
  return date.getHours() * 60 + date.getMinutes()
}

function weekdayKey(date: Date) {
  return ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][date.getDay()]
}

function getAvailabilityForDate(preferences: CalendarPreferences, date: Date) {
  const fallback = { enabled: false, start: '08:00', end: '17:00' }
  return preferences.workingHours[weekdayKey(date)] ?? fallback
}

function parseClockMinutes(value: string, fallback: number) {
  const match = value.match(/^(\d{2}):(\d{2})$/)
  if (!match) return fallback
  return Number(match[1]) * 60 + Number(match[2])
}

function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60000)
}

function overlaps(left: AttorneyCalendarItem, right: AttorneyCalendarItem) {
  if (left.id === right.id) return false
  const leftStart = safeDate(left.startAt)
  const leftEnd = safeDate(left.endAt)
  const rightStart = safeDate(right.startAt)
  const rightEnd = safeDate(right.endAt)
  if (!leftStart || !leftEnd || !rightStart || !rightEnd) return false
  return +leftStart < +rightEnd && +rightStart < +leftEnd
}

function expandWithBuffers(item: AttorneyCalendarItem) {
  const start = safeDate(item.startAt)
  const end = safeDate(item.endAt)
  if (!start || !end) return null
  return {
    start: addMinutes(start, -(item.prepBeforeMinutes + item.travelBeforeMinutes)),
    end: addMinutes(end, item.travelAfterMinutes),
  }
}

function overlapsWithTravel(left: AttorneyCalendarItem, right: AttorneyCalendarItem) {
  const expandedLeft = expandWithBuffers(left)
  const expandedRight = expandWithBuffers(right)
  if (!expandedLeft || !expandedRight) return false
  return +expandedLeft.start < +expandedRight.end && +expandedRight.start < +expandedLeft.end
}

function buildMonthGrid(anchor: Date) {
  const monthStart = startOfMonth(anchor)
  const gridStart = addDays(monthStart, -monthStart.getDay())
  return Array.from({ length: 42 }, (_, index) => addDays(gridStart, index))
}

function buildWeekDays(anchor: Date) {
  const weekStart = startOfWeek(anchor)
  return Array.from({ length: 7 }, (_, index) => addDays(weekStart, index))
}

function buildTimeSlots(startHour = 6, endHour = 20, stepMinutes = 30) {
  const slots: { label: string; minutes: number }[] = []
  for (let minutes = startHour * 60; minutes <= endHour * 60; minutes += stepMinutes) {
    const hour = Math.floor(minutes / 60)
    const minute = minutes % 60
    const labelDate = new Date(2026, 0, 1, hour, minute)
    slots.push({
      label: labelDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }),
      minutes,
    })
  }
  return slots
}

function buildCurrentReturnTo(pathname: string, input: {
  view: AttorneyCalendarView
  date: Date
  caseId: string
}) {
  const query = new URLSearchParams()
  query.set('view', input.view)
  query.set('date', dateToken(input.date))
  if (input.caseId) query.set('case', input.caseId)
  return `${pathname}?${query.toString()}`
}

function eventMatchesSearch(item: AttorneyCalendarItem, needle: string) {
  if (!needle) return true
  const haystack = [
    item.title,
    item.linkedCourt,
    item.linkedCounty,
    item.linkedState,
    item.driverName,
    item.fleetName,
    item.citationNumber,
    item.caseId,
  ]
    .join(' ')
    .toLowerCase()
  return haystack.includes(needle)
}

function isUrgentItem(item: AttorneyCalendarItem, now = new Date()) {
  const start = safeDate(item.startAt)
  if (!start) return false
  if (item.status === 'COMPLETED' || item.status === 'DONE' || item.status === 'CANCELLED') return false
  const diffHours = (+start - +now) / 3600000
  return diffHours <= 24 || item.family === 'deadline'
}

function getItemWarnings(item: AttorneyCalendarItem, scopedItems: AttorneyCalendarItem[], preferences: CalendarPreferences) {
  const warnings: string[] = []
  const day = safeDate(item.startAt)
  if (!day) return warnings

  const availability = getAvailabilityForDate(preferences, day)
  const startMinutes = minutesFromMidnight(item.startAt)
  const endMinutes = minutesFromMidnight(item.endAt)
  const workStart = parseClockMinutes(availability.start, 8 * 60)
  const workEnd = parseClockMinutes(availability.end, 17 * 60)

  if (!availability.enabled && item.eventType !== 'PERSONAL' && item.eventType !== 'BLOCKED_TIME') {
    warnings.push('Outside configured working day.')
  } else if (startMinutes < workStart || endMinutes > workEnd) {
    warnings.push('Outside configured working hours.')
  }

  const sameOwnerItems = scopedItems.filter(
    (other) =>
      other.id !== item.id &&
      other.assignedUserId === item.assignedUserId &&
      other.status !== 'CANCELLED' &&
      other.status !== 'COMPLETED'
  )

  if (sameOwnerItems.some((other) => overlaps(item, other))) {
    warnings.push('Overlaps another scheduled event.')
  }

  if (
    sameOwnerItems.some(
      (other) =>
        ['BLOCKED_TIME', 'PERSONAL'].includes(other.eventType) &&
        overlaps(item, other)
    )
  ) {
    warnings.push('Conflicts with blocked or private time.')
  }

  if (sameOwnerItems.some((other) => overlapsWithTravel(item, other))) {
    warnings.push('Travel or prep buffer overlap detected.')
  }

  return warnings
}

function buildOpenGaps(day: Date, items: AttorneyCalendarItem[], preferences: CalendarPreferences) {
  const availability = getAvailabilityForDate(preferences, day)
  if (!availability.enabled) return [] as DayGap[]

  const workStartMinutes = parseClockMinutes(availability.start, 8 * 60)
  const workEndMinutes = parseClockMinutes(availability.end, 17 * 60)
  const workStart = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(workStartMinutes / 60), workStartMinutes % 60)
  const workEnd = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(workEndMinutes / 60), workEndMinutes % 60)

  const booked = items
    .filter((item) => item.status !== 'CANCELLED')
    .map((item) => ({
      start: safeDate(item.startAt),
      end: safeDate(item.endAt),
    }))
    .filter((item): item is { start: Date; end: Date } => Boolean(item.start && item.end))
    .sort((left, right) => +left.start - +right.start)

  const gaps: DayGap[] = []
  let cursor = workStart
  for (const slot of booked) {
    if (+slot.start > +cursor) {
      gaps.push({ start: cursor, end: slot.start })
    }
    if (+slot.end > +cursor) {
      cursor = slot.end
    }
  }

  if (+cursor < +workEnd) gaps.push({ start: cursor, end: workEnd })
  return gaps.filter((gap) => (+gap.end - +gap.start) / 60000 >= 30)
}

function buildDayColumnLayout(items: AttorneyCalendarItem[]) {
  const timed = items
    .filter((item) => !item.allDay && item.status !== 'CANCELLED')
    .slice()
    .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))

  const lanes: DayColumnLayout[] = []
  const laneEndTimes: number[] = []

  for (const item of timed) {
    const start = +new Date(item.startAt)
    let lane = 0
    while (lane < laneEndTimes.length && laneEndTimes[lane] > start) lane += 1
    laneEndTimes[lane] = +new Date(item.endAt)
    lanes.push({ item, lane, totalLanes: 1 })
  }

  for (const layout of lanes) {
    layout.totalLanes =
      Math.max(
        1,
        ...lanes
          .filter((candidate) => overlaps(layout.item, candidate.item) || candidate.item.id === layout.item.id)
          .map((candidate) => candidate.lane + 1)
      )
  }

  return lanes
}

function buildDraftFromItem(item: AttorneyCalendarItem): CalendarDraft {
  const recurrenceRule =
    item.metadata?.recurrence_rule && typeof item.metadata.recurrence_rule === 'object'
      ? (item.metadata.recurrence_rule as Record<string, unknown>)
      : null

  return {
    sourceKind: item.sourceKind,
    itemId: item.id,
    caseId: item.caseId ?? '',
    title: item.title,
    eventType: item.eventType,
    startDate: toInputDate(item.startAt),
    startTime: toInputTime(item.startAt, item.allDay),
    endDate: toInputDate(item.endAt),
    endTime: toInputTime(item.endAt, item.allDay),
    allDay: item.allDay,
    assignedUserId: item.assignedUserId ?? item.ownerUserId ?? '',
    visibility: item.visibility,
    status: item.status || 'SCHEDULED',
    notes: item.notes ?? '',
    location: item.location ?? '',
    meetingUrl: item.meetingUrl ?? '',
    referenceLink: String(item.metadata?.reference_link ?? ''),
    linkedCourt: item.linkedCourt ?? '',
    linkedState: item.linkedState ?? '',
    linkedCounty: item.linkedCounty ?? '',
    prepBeforeMinutes: String(item.prepBeforeMinutes ?? 0),
    travelBeforeMinutes: String(item.travelBeforeMinutes ?? 0),
    travelAfterMinutes: String(item.travelAfterMinutes ?? 0),
    reminderOffsetsCsv: (item.reminderOffsets ?? []).join(', '),
    syncCaseCourt: item.sourceKind === 'case_court' || item.eventType === 'COURT_APPEARANCE' || item.eventType === 'HEARING',
    recurrenceFrequency: String(recurrenceRule?.frequency ?? 'NONE'),
    recurrenceInterval: String(recurrenceRule?.interval ?? '1'),
    recurrenceUntil: String(recurrenceRule?.until ?? ''),
    recurrenceCount: String(recurrenceRule?.count ?? ''),
  }
}

function buildDraftFromSlot(input: {
  date: Date
  caseId: string
  assignedUserId: string
  eventType?: string
  sourceKind?: 'task' | 'calendar' | 'case_court'
}) {
  const eventMeta = getCalendarEventTypeMeta(input.eventType || 'COURT_APPEARANCE')
  const start = new Date(input.date)
  const end = addMinutes(start, eventMeta.defaultDuration)

  return {
    sourceKind: input.sourceKind ?? eventMeta.storage,
    itemId: '',
    caseId: input.caseId,
    title: '',
    eventType: eventMeta.value,
    startDate: dateToken(start),
    startTime: eventMeta.defaultAllDay ? '' : toInputTime(start.toISOString()),
    endDate: dateToken(end),
    endTime: eventMeta.defaultAllDay ? '' : toInputTime(end.toISOString()),
    allDay: eventMeta.defaultAllDay,
    assignedUserId: input.assignedUserId,
    visibility: eventMeta.value === 'PERSONAL' ? 'PRIVATE' : 'SHARED',
    status: 'SCHEDULED',
    notes: '',
    location: '',
    meetingUrl: '',
    referenceLink: '',
    linkedCourt: '',
    linkedState: '',
    linkedCounty: '',
    prepBeforeMinutes: '0',
    travelBeforeMinutes: '0',
    travelAfterMinutes: '0',
    reminderOffsetsCsv: eventMeta.defaultReminderOffsets.join(', '),
    syncCaseCourt: ['COURT_APPEARANCE', 'HEARING'].includes(eventMeta.value),
    recurrenceFrequency: 'NONE',
    recurrenceInterval: '1',
    recurrenceUntil: '',
    recurrenceCount: '',
  } satisfies CalendarDraft
}

function CalendarSubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" className="button-link primary legal-calendar-submit" disabled={pending}>
      {pending ? 'Saving...' : label}
    </button>
  )
}

function CalendarActionForm({
  action,
  children,
}: {
  action: (formData: FormData) => void | Promise<void>
  children: ReactNode
}) {
  return <form action={action}>{children}</form>
}

export function AttorneyCalendarWorkspace({
  items,
  cases,
  firmMembers,
  connectionSummary,
  preferences,
  initialView,
  initialDateToken,
  initialCaseId,
  notices,
  calendarStorageAvailable,
}: CalendarWorkspaceProps) {
  const pathname = usePathname()
  const [view, setView] = useState<AttorneyCalendarView>(initialView)
  const [focusedDate, setFocusedDate] = useState<Date>(parseDateToken(initialDateToken))
  const [selectedCaseId, setSelectedCaseId] = useState(initialCaseId)
  const [selectedOwnerId, setSelectedOwnerId] = useState('')
  const [selectedType, setSelectedType] = useState('')
  const [selectedVisibility, setSelectedVisibility] = useState('')
  const [selectedState, setSelectedState] = useState('')
  const [selectedCounty, setSelectedCounty] = useState('')
  const [selectedCourt, setSelectedCourt] = useState('')
  const [search, setSearch] = useState('')
  const [upcomingOnly, setUpcomingOnly] = useState(false)
  const [urgentOnly, setUrgentOnly] = useState(false)
  const [panelMode, setPanelMode] = useState<'day' | 'event' | 'compose' | 'availability'>('day')
  const [selectedItemId, setSelectedItemId] = useState('')
  const [draft, setDraft] = useState<CalendarDraft | null>(null)
  const [draggingItemId, setDraggingItemId] = useState('')

  const caseById = useMemo(() => new Map(cases.map((item) => [item.id, item])), [cases])
  const fallbackOwnerId = firmMembers.find((item) => item.isCurrentUser)?.userId ?? firmMembers[0]?.userId ?? ''
  const today = startOfDay(new Date())
  const currentReturnTo = useMemo(
    () =>
      buildCurrentReturnTo(pathname, {
        view,
        date: focusedDate,
        caseId: selectedCaseId,
      }),
    [focusedDate, pathname, selectedCaseId, view]
  )

  const visibleItems = useMemo(() => {
    return items
      .filter((item) => (selectedCaseId ? item.caseId === selectedCaseId : true))
      .filter((item) => (selectedOwnerId ? item.assignedUserId === selectedOwnerId || item.ownerUserId === selectedOwnerId : true))
      .filter((item) => (selectedType ? item.eventType === selectedType : true))
      .filter((item) => (selectedVisibility ? item.visibility === selectedVisibility : true))
      .filter((item) => (selectedState ? item.linkedState === selectedState : true))
      .filter((item) => (selectedCounty ? item.linkedCounty === selectedCounty : true))
      .filter((item) => (selectedCourt ? item.linkedCourt === selectedCourt : true))
      .filter((item) => eventMatchesSearch(item, search.trim().toLowerCase()))
      .filter((item) => (upcomingOnly ? +new Date(item.endAt) >= +today : true))
      .filter((item) => (urgentOnly ? isUrgentItem(item, new Date()) : true))
      .sort((left, right) => +new Date(left.startAt) - +new Date(right.startAt))
  }, [
    items,
    search,
    selectedCaseId,
    selectedCounty,
    selectedCourt,
    selectedOwnerId,
    selectedState,
    selectedType,
    selectedVisibility,
    today,
    upcomingOnly,
    urgentOnly,
  ])

  const warningsById = useMemo(
    () => new Map(visibleItems.map((item) => [item.id, getItemWarnings(item, visibleItems, preferences)])),
    [preferences, visibleItems]
  )

  const monthDays = useMemo(() => buildMonthGrid(focusedDate), [focusedDate])
  const weekDays = useMemo(() => buildWeekDays(focusedDate), [focusedDate])
  const selectedDayItems = useMemo(
    () =>
      visibleItems.filter((item) => {
        const start = safeDate(item.startAt)
        return start ? isSameDay(start, focusedDate) : false
      }),
    [focusedDate, visibleItems]
  )
  const dayGaps = useMemo(() => buildOpenGaps(focusedDate, selectedDayItems, preferences), [focusedDate, preferences, selectedDayItems])
  const selectedEvent = useMemo(() => visibleItems.find((item) => item.id === selectedItemId) ?? null, [selectedItemId, visibleItems])
  const todayItems = useMemo(
    () =>
      visibleItems.filter((item) => {
        const start = safeDate(item.startAt)
        return start ? isSameDay(start, today) : false
      }),
    [today, visibleItems]
  )
  const upcomingSevenDays = useMemo(
    () =>
      visibleItems.filter((item) => {
        const start = safeDate(item.startAt)
        return start ? +start >= +today && +start <= +addDays(today, 7) : false
      }),
    [today, visibleItems]
  )
  const urgentItems = useMemo(() => visibleItems.filter((item) => isUrgentItem(item)), [visibleItems])
  const conflictCount = useMemo(() => [...warningsById.values()].filter((warnings) => warnings.length > 0).length, [warningsById])
  const stateOptions = useMemo(
    () => [...new Set(cases.map((item) => item.state).filter(Boolean))].sort((left, right) => left.localeCompare(right)),
    [cases]
  )
  const countyOptions = useMemo(
    () =>
      [...new Set(cases.map((item) => item.county).filter(Boolean) as string[])].sort((left, right) =>
        left.localeCompare(right)
      ),
    [cases]
  )
  const courtOptions = useMemo(
    () =>
      [...new Set(cases.map((item) => item.courtName).filter(Boolean) as string[])].sort((left, right) =>
        left.localeCompare(right)
      ),
    [cases]
  )
  const agendaGroups = useMemo(() => {
    const grouped = new Map<string, AttorneyCalendarItem[]>()
    for (const item of visibleItems) {
      const start = safeDate(item.startAt)
      if (!start) continue
      const token = dateToken(start)
      const bucket = grouped.get(token) ?? []
      bucket.push(item)
      grouped.set(token, bucket)
    }
    return [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right))
  }, [visibleItems])
  const caseCalendarItems = useMemo(
    () => (selectedCaseId ? visibleItems.filter((item) => item.caseId === selectedCaseId) : []),
    [selectedCaseId, visibleItems]
  )
  const teamRows = useMemo(
    () =>
      firmMembers.map((member) => ({
        member,
        items: visibleItems.filter((item) => item.assignedUserId === member.userId || item.ownerUserId === member.userId),
      })),
    [firmMembers, visibleItems]
  )
  const timeSlots = useMemo(() => buildTimeSlots(), [])

  function openDayPanel(date: Date) {
    setFocusedDate(startOfDay(date))
    setSelectedItemId('')
    setDraft(null)
    setPanelMode('day')
  }

  function openEvent(item: AttorneyCalendarItem) {
    setSelectedItemId(item.id)
    setDraft(null)
    setPanelMode('event')
  }

  function openDraft(input: CalendarDraft) {
    setDraft(input)
    setSelectedItemId(input.itemId)
    setPanelMode('compose')
  }

  function handleCreateForDate(date: Date, eventType?: string) {
    const requestedType = eventType || 'COURT_APPEARANCE'
    const eventMeta = getCalendarEventTypeMeta(requestedType)
    const sourceKind =
      !calendarStorageAvailable && eventMeta.storage === 'calendar'
        ? selectedCaseId && ['COURT_APPEARANCE', 'HEARING'].includes(requestedType)
          ? 'case_court'
          : 'task'
        : undefined
    const effectiveType =
      !calendarStorageAvailable && eventMeta.storage === 'calendar' && !selectedCaseId
        ? 'REMINDER'
        : requestedType
    openDayPanel(date)
    openDraft(
      buildDraftFromSlot({
        date,
        caseId: selectedCaseId,
        assignedUserId: selectedOwnerId || fallbackOwnerId,
        eventType: effectiveType,
        sourceKind,
      })
    )
  }

  function shiftPeriod(direction: -1 | 1) {
    if (view === 'month') {
      setFocusedDate(new Date(focusedDate.getFullYear(), focusedDate.getMonth() + direction, 1))
      return
    }
    if (view === 'week' || view === 'team') {
      setFocusedDate(addDays(focusedDate, 7 * direction))
      return
    }
    setFocusedDate(addDays(focusedDate, direction))
  }

  function getRangeLabel() {
    if (view === 'month') {
      return focusedDate.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    }
    if (view === 'week' || view === 'team') {
      const weekStart = startOfWeek(focusedDate)
      const weekEnd = addDays(weekStart, 6)
      return `${formatShortDate(weekStart)} - ${formatShortDate(weekEnd)}`
    }
    if (view === 'agenda') return 'Agenda / List'
    if (view === 'case') return selectedCaseId ? 'Case Calendar' : 'Select a case'
    return formatLongDate(focusedDate)
  }

  function handleDropOnSlot(date: Date, minutes: number, droppedId?: string) {
    const resolvedId = droppedId || draggingItemId
    if (!resolvedId) return
    const item = visibleItems.find((candidate) => candidate.id === resolvedId)
    if (!item) return
    const originalStart = safeDate(item.startAt)
    const originalEnd = safeDate(item.endAt)
    if (!originalStart || !originalEnd) return
    const durationMinutes = Math.max(15, Math.round((+originalEnd - +originalStart) / 60000))
    const slotDate = new Date(date.getFullYear(), date.getMonth(), date.getDate(), Math.floor(minutes / 60), minutes % 60)
    const draftFromItem = buildDraftFromItem(item)
    draftFromItem.startDate = dateToken(slotDate)
    draftFromItem.startTime = `${String(slotDate.getHours()).padStart(2, '0')}:${String(slotDate.getMinutes()).padStart(2, '0')}`
    const end = addMinutes(slotDate, durationMinutes)
    draftFromItem.endDate = dateToken(end)
    draftFromItem.endTime = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`
    draftFromItem.notes = [draftFromItem.notes, 'Reschedule prepared from drag and drop. Review and save.'].filter(Boolean).join('\n\n')
    openDraft(draftFromItem)
    setDraggingItemId('')
  }

  return (
    <div className="legal-calendar-shell">
      {notices.length ? (
        <div className="legal-calendar-notices">
          {notices.map((notice) => (
            <p key={notice} className="notice">
              {notice}
            </p>
          ))}
        </div>
      ) : null}

      <section className="legal-calendar-summary-grid">
        <article className="legal-calendar-summary-card">
          <span className="legal-calendar-summary-label">Today</span>
          <strong>{todayItems.length}</strong>
          <span>{todayItems.length ? 'Booked events and hearings' : 'Open day so far'}</span>
        </article>
        <article className="legal-calendar-summary-card">
          <span className="legal-calendar-summary-label">Upcoming 7 Days</span>
          <strong>{upcomingSevenDays.length}</strong>
          <span>Hearings, calls, reminders, and prep</span>
        </article>
        <article className="legal-calendar-summary-card">
          <span className="legal-calendar-summary-label">Urgent / At Risk</span>
          <strong>{urgentItems.length}</strong>
          <span>{urgentItems.length ? 'Needs attention soon' : 'No urgent matters'}</span>
        </article>
        <article className="legal-calendar-summary-card">
          <span className="legal-calendar-summary-label">Conflicts</span>
          <strong>{conflictCount}</strong>
          <span>{conflictCount ? 'Overlap or after-hours warning' : 'No active conflicts'}</span>
        </article>
      </section>

      <div className="legal-calendar-toolbar card">
        <div className="legal-calendar-toolbar-row">
          <div className="legal-calendar-toolbar-cluster">
            <button type="button" className="button-link secondary" onClick={() => openDayPanel(today)}>
              Today
            </button>
            <button type="button" className="button-link ghost" onClick={() => shiftPeriod(-1)} aria-label="Previous period">
              {'<'}
            </button>
            <strong className="legal-calendar-range-label">{getRangeLabel()}</strong>
            <button type="button" className="button-link ghost" onClick={() => shiftPeriod(1)} aria-label="Next period">
              {'>'}
            </button>
          </div>
          <div className="legal-calendar-toolbar-cluster">
            <input
              id="legal-calendar-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="legal-calendar-search"
              placeholder="Search case, citation, driver, court, or title"
            />
            <button type="button" className="button-link primary" onClick={() => handleCreateForDate(focusedDate, 'COURT_APPEARANCE')}>
              Add Event
            </button>
            <button type="button" className="button-link secondary" onClick={() => handleCreateForDate(focusedDate, 'REMINDER')}>
              Add Reminder
            </button>
            <details className="legal-calendar-overflow">
              <summary>More</summary>
              <div className="legal-calendar-overflow-menu">
                <button type="button" className="button-link ghost" onClick={() => setPanelMode('availability')}>
                  Availability
                </button>
                <Link href="/attorney/integrations" className="button-link ghost">
                  Sync Settings
                </Link>
                <button type="button" className="button-link ghost" onClick={() => setView('team')}>
                  Team Overlay
                </button>
              </div>
            </details>
          </div>
        </div>
        <div className="legal-calendar-toolbar-row legal-calendar-toolbar-row-wrap">
          <div className="legal-calendar-view-switch">
            {CALENDAR_VIEW_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                className={`legal-calendar-view-button ${view === option ? 'active' : ''}`}
                onClick={() => setView(option)}
              >
                {option === 'agenda' ? 'Agenda' : option.charAt(0).toUpperCase() + option.slice(1)}
              </button>
            ))}
          </div>
          <div className="legal-calendar-sync-pill-row">
            <span className={`legal-calendar-sync-pill ${connectionSummary.calendarConnected ? 'connected' : ''}`}>
              Calendar {connectionSummary.calendarConnected ? `Connected${connectionSummary.calendarAddress ? ` - ${connectionSummary.calendarAddress}` : ''}` : 'Manual mode'}
            </span>
            <span className={`legal-calendar-sync-pill ${connectionSummary.emailConnected ? 'connected' : ''}`}>
              Email {connectionSummary.emailConnected ? `Linked${connectionSummary.emailAddress ? ` - ${connectionSummary.emailAddress}` : ''}` : 'Manual logging'}
            </span>
          </div>
        </div>
      </div>

      <section className="legal-calendar-layout">
        <aside className="legal-calendar-sidebar card">
          <div className="legal-calendar-sidebar-section">
            <p className="legal-calendar-sidebar-eyebrow">Saved Views</p>
            <div className="legal-calendar-chip-grid">
              <button type="button" className="legal-calendar-chip-button" onClick={() => { setView('day'); openDayPanel(today) }}>
                Today Focus
              </button>
              <button type="button" className="legal-calendar-chip-button" onClick={() => { setView('agenda'); setUpcomingOnly(true); setSelectedType('COURT_APPEARANCE') }}>
                Upcoming Hearings
              </button>
              <button type="button" className="legal-calendar-chip-button" onClick={() => { setView('agenda'); setUrgentOnly(true) }}>
                Deadline Watch
              </button>
              <button type="button" className="legal-calendar-chip-button" onClick={() => setPanelMode('availability')}>
                Availability
              </button>
            </div>
          </div>

          <div className="legal-calendar-sidebar-section">
            <p className="legal-calendar-sidebar-eyebrow">Filters</p>
            <div className="legal-calendar-filter-grid">
              <label>
                <span>Case</span>
                <select value={selectedCaseId} onChange={(event) => setSelectedCaseId(event.target.value)}>
                  <option value="">All matters</option>
                  {cases.map((caseOption) => (
                    <option key={caseOption.id} value={caseOption.id}>
                      {caseOption.citationNumber || caseOption.id.slice(0, 8)} - {caseOption.driverName}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Event Type</span>
                <select value={selectedType} onChange={(event) => setSelectedType(event.target.value)}>
                  <option value="">All event types</option>
                  {CALENDAR_EVENT_TYPE_OPTIONS.filter((option) => calendarStorageAvailable || option.storage === 'task').map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Attorney / Staff</span>
                <select value={selectedOwnerId} onChange={(event) => setSelectedOwnerId(event.target.value)}>
                  <option value="">Entire firm</option>
                  {firmMembers.map((member) => (
                    <option key={member.userId} value={member.userId}>
                      {member.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Visibility</span>
                <select value={selectedVisibility} onChange={(event) => setSelectedVisibility(event.target.value)}>
                  <option value="">All visibility</option>
                  <option value="SHARED">Shared</option>
                  <option value="PRIVATE">Private</option>
                </select>
              </label>
              <label>
                <span>State</span>
                <select value={selectedState} onChange={(event) => setSelectedState(event.target.value)}>
                  <option value="">All states</option>
                  {stateOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>County</span>
                <select value={selectedCounty} onChange={(event) => setSelectedCounty(event.target.value)}>
                  <option value="">All counties</option>
                  {countyOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Court</span>
                <select value={selectedCourt} onChange={(event) => setSelectedCourt(event.target.value)}>
                  <option value="">All courts</option>
                  {courtOptions.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="legal-calendar-toggle-row">
              <label className="legal-calendar-inline-toggle">
                <input type="checkbox" checked={upcomingOnly} onChange={(event) => setUpcomingOnly(event.target.checked)} />
                <span>Upcoming only</span>
              </label>
              <label className="legal-calendar-inline-toggle">
                <input type="checkbox" checked={urgentOnly} onChange={(event) => setUrgentOnly(event.target.checked)} />
                <span>Urgent only</span>
              </label>
            </div>
            <button
              type="button"
              className="button-link ghost"
              onClick={() => {
                setSelectedCaseId('')
                setSelectedOwnerId('')
                setSelectedType('')
                setSelectedVisibility('')
                setSelectedState('')
                setSelectedCounty('')
                setSelectedCourt('')
                setSearch('')
                setUpcomingOnly(false)
                setUrgentOnly(false)
              }}
            >
              Clear filters
            </button>
          </div>

          <div className="legal-calendar-sidebar-section">
            <p className="legal-calendar-sidebar-eyebrow">Today / Capacity</p>
            <ul className="legal-calendar-metric-list">
              <li>
                <strong>{todayItems.length}</strong>
                <span>Booked today</span>
              </li>
              <li>
                <strong>{dayGaps.length}</strong>
                <span>Open windows on selected day</span>
              </li>
              <li>
                <strong>{preferences.hearingDurationMinutes} min</strong>
                <span>Default hearing duration</span>
              </li>
            </ul>
          </div>

          <div className="legal-calendar-sidebar-section">
            <p className="legal-calendar-sidebar-eyebrow">Integration Readiness</p>
            <div className="legal-calendar-sync-card">
              <strong>
                {connectionSummary.calendarConnected
                  ? `${connectionSummary.calendarProvider === 'MICROSOFT' ? 'Microsoft' : 'Google'} calendar connected`
                  : 'Manual calendar mode'}
              </strong>
              <span>{connectionSummary.calendarAddress || 'No synced calendar'}</span>
              <span>
                {connectionSummary.lastCalendarSyncAt
                  ? `Last status update ${formatDateTime(connectionSummary.lastCalendarSyncAt)}`
                  : 'No sync timestamp yet'}
              </span>
              {connectionSummary.calendarStatus ? <span>Provider status: {connectionSummary.calendarStatus}</span> : null}
              {connectionSummary.calendarError ? <span className="error">Latest sync issue: {connectionSummary.calendarError}</span> : null}
              <Link href="/attorney/integrations" className="button-link secondary">
                Manage Integrations
              </Link>
            </div>
          </div>
        </aside>

        <div className="legal-calendar-main card">
          {view === 'month' ? (
            <div className="legal-calendar-month-shell">
              <div className="legal-calendar-month-grid">
                {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((day) => (
                  <div key={day} className="legal-calendar-month-head">
                    {day}
                  </div>
                ))}
                {monthDays.map((day) => {
                  const token = dateToken(day)
                  const events = visibleItems.filter((item) => {
                    const start = safeDate(item.startAt)
                    return start ? isSameDay(start, day) : false
                  })
                  return (
                    <article
                      key={token}
                      className={`legal-calendar-month-cell ${day.getMonth() !== focusedDate.getMonth() ? 'outside' : ''} ${isSameDay(day, today) ? 'today' : ''} ${isSameDay(day, focusedDate) ? 'selected' : ''}`}
                    >
                      <button type="button" className="legal-calendar-date-trigger" onClick={() => openDayPanel(day)}>
                        <span>{day.getDate()}</span>
                        <small>{events.length ? `${events.length} scheduled` : 'Open'}</small>
                      </button>
                      <div className="legal-calendar-month-events">
                        {events.slice(0, 3).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={`legal-calendar-event-pill tone-${item.colorKey}`}
                            onClick={() => openEvent(item)}
                          >
                            <span>{formatTime(item.startAt, item.allDay)}</span>
                            <strong>{item.title}</strong>
                          </button>
                        ))}
                        {events.length > 3 ? <span className="legal-calendar-more-link">+{events.length - 3} more</span> : null}
                      </div>
                    </article>
                  )
                })}
              </div>
            </div>
          ) : null}

          {view === 'week' || view === 'day' ? (
            <div className="legal-calendar-time-shell">
              <div className="legal-calendar-time-head">
                <div className="legal-calendar-time-axis-head">Time</div>
                {(view === 'day' ? [focusedDate] : weekDays).map((day) => (
                  <button
                    key={dateToken(day)}
                    type="button"
                    className={`legal-calendar-time-day-head ${isSameDay(day, focusedDate) ? 'active' : ''}`}
                    onClick={() => openDayPanel(day)}
                  >
                    <strong>{day.toLocaleDateString('en-US', { weekday: 'short' })}</strong>
                    <span>{day.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
                  </button>
                ))}
              </div>
              <div className={`legal-calendar-time-grid columns-${view === 'day' ? 1 : 7}`}>
                <div className="legal-calendar-time-axis">
                  {timeSlots.map((slot) => (
                    <div key={`axis-${slot.minutes}`} className="legal-calendar-time-label">
                      {slot.label}
                    </div>
                  ))}
                </div>
                {(view === 'day' ? [focusedDate] : weekDays).map((day) => {
                  const token = dateToken(day)
                  const events = visibleItems.filter((item) => {
                    const start = safeDate(item.startAt)
                    return start ? isSameDay(start, day) : false
                  })
                  const timedLayout = buildDayColumnLayout(events)
                  const availability = getAvailabilityForDate(preferences, day)
                  const currentMinutes = isSameDay(day, new Date()) ? new Date().getHours() * 60 + new Date().getMinutes() : null
                  return (
                    <div key={token} className="legal-calendar-day-column">
                      <div className="legal-calendar-all-day-strip">
                        {events.filter((item) => item.allDay).map((item) => (
                          <button
                            key={item.id}
                            type="button"
                            className={`legal-calendar-event-pill tone-${item.colorKey}`}
                            onClick={() => openEvent(item)}
                          >
                            <strong>{item.title}</strong>
                          </button>
                        ))}
                      </div>
                      <div className="legal-calendar-day-slots">
                        {!availability.enabled ? <div className="legal-calendar-availability-mask">Not a working day</div> : null}
                        {timeSlots.slice(0, -1).map((slot) => (
                          <button
                            key={`${token}-${slot.minutes}`}
                            type="button"
                            className="legal-calendar-slot-button"
                            onClick={() => {
                              const slotDate = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(slot.minutes / 60), slot.minutes % 60)
                              handleCreateForDate(slotDate)
                            }}
                            onDragOver={(event) => event.preventDefault()}
                            onDrop={(event) => handleDropOnSlot(day, slot.minutes, event.dataTransfer.getData('text/plain'))}
                          >
                            <span className="sr-only">Create event at {slot.label}</span>
                          </button>
                        ))}
                        {currentMinutes !== null ? (
                          <div className="legal-calendar-now-line" style={{ top: `${((currentMinutes - 360) / (14 * 60)) * 100}%` }} />
                        ) : null}
                        {timedLayout.map(({ item, lane, totalLanes }) => {
                          const startMinutes = Math.max(360, minutesFromMidnight(item.startAt))
                          const endMinutes = Math.min(20 * 60, Math.max(startMinutes + 15, minutesFromMidnight(item.endAt)))
                          const top = ((startMinutes - 360) / (14 * 60)) * 100
                          const height = Math.max(3.5, ((endMinutes - startMinutes) / (14 * 60)) * 100)
                          const left = `${(lane / totalLanes) * 100}%`
                          const width = `${100 / totalLanes}%`
                          return (
                            <button
                              key={item.id}
                              type="button"
                              draggable
                              className={`legal-calendar-timed-event tone-${item.colorKey}`}
                              style={{ top: `${top}%`, height: `${height}%`, left, width }}
                              onDragStart={(event) => {
                                event.dataTransfer.setData('text/plain', item.id)
                                event.dataTransfer.effectAllowed = 'move'
                                setDraggingItemId(item.id)
                              }}
                              onDragEnd={() => setDraggingItemId('')}
                              onClick={() => openEvent(item)}
                            >
                              <strong>{item.title}</strong>
                              <span>{formatTime(item.startAt, item.allDay)} - {formatTime(item.endAt, item.allDay)}</span>
                              {item.driverName ? <span>{item.driverName}</span> : null}
                            </button>
                          )
                        })}
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ) : null}

          {view === 'agenda' ? (
            <div className="legal-calendar-agenda-shell">
              {!agendaGroups.length ? (
                <div className="legal-calendar-empty-state">
                  <strong>No events match the current filters.</strong>
                  <span>Try clearing filters or create a new hearing, reminder, or blocked-time entry.</span>
                  <button type="button" className="button-link primary" onClick={() => handleCreateForDate(focusedDate)}>
                    Add Event
                  </button>
                </div>
              ) : (
                agendaGroups.map(([token, group]) => (
                  <section key={token} className="legal-calendar-agenda-day">
                    <header>
                      <strong>{formatLongDate(parseDateToken(token))}</strong>
                      <span>{group.length} items</span>
                    </header>
                    <div className="legal-calendar-agenda-list">
                      {group.map((item) => (
                        <button key={item.id} type="button" className="legal-calendar-agenda-row" onClick={() => openEvent(item)}>
                          <span className={`legal-calendar-badge tone-${item.colorKey}`}>{getCalendarEventTypeMeta(item.eventType).label}</span>
                          <div>
                            <strong>{item.title}</strong>
                            <span>{formatTime(item.startAt, item.allDay)} · {item.driverName || item.fleetName || item.linkedCourt || 'Unassigned matter'}</span>
                          </div>
                          <span>{item.ownerLabel}</span>
                        </button>
                      ))}
                    </div>
                  </section>
                ))
              )}
            </div>
          ) : null}

          {view === 'case' ? (
            <div className="legal-calendar-case-shell">
              {!selectedCaseId ? (
                <div className="legal-calendar-empty-state">
                  <strong>Select a case to open its calendar.</strong>
                  <span>Case calendar view keeps hearings, reminders, prep, travel, and follow-up in one matter timeline.</span>
                </div>
              ) : (
                <>
                  <header className="legal-calendar-case-header">
                    <div>
                      <strong>{caseById.get(selectedCaseId)?.citationNumber || selectedCaseId.slice(0, 8)}</strong>
                      <span>{caseById.get(selectedCaseId)?.driverName || 'Case calendar'} · {caseById.get(selectedCaseId)?.courtName || 'Court not set'}</span>
                    </div>
                    <button type="button" className="button-link primary" onClick={() => handleCreateForDate(focusedDate, 'HEARING')}>
                      Add Hearing
                    </button>
                  </header>
                  <div className="legal-calendar-case-timeline">
                    {caseCalendarItems.length ? (
                      caseCalendarItems.map((item) => (
                        <button key={item.id} type="button" className="legal-calendar-case-row" onClick={() => openEvent(item)}>
                          <span className={`legal-calendar-badge tone-${item.colorKey}`}>{getCalendarEventTypeMeta(item.eventType).label}</span>
                          <div>
                            <strong>{item.title}</strong>
                            <span>{formatDateTime(item.startAt)} · {item.status}</span>
                          </div>
                          <span>{item.ownerLabel}</span>
                        </button>
                      ))
                    ) : (
                      <div className="legal-calendar-empty-state compact">
                        <strong>No calendar items for this matter yet.</strong>
                        <span>Create a hearing, filing deadline, or follow-up to start the docket timeline.</span>
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          ) : null}

          {view === 'team' ? (
            <div className="legal-calendar-team-shell">
              {teamRows.map(({ member, items: memberItems }) => (
                <article key={member.userId} className="legal-calendar-team-card">
                  <header>
                    <strong>{member.label}</strong>
                    <span>{member.roleInFirm || (member.isCurrentUser ? 'Current user' : 'Firm member')}</span>
                  </header>
                  <div className="legal-calendar-team-events">
                    {memberItems.slice(0, 8).map((item) => (
                      <button key={item.id} type="button" className="legal-calendar-team-row" onClick={() => openEvent(item)}>
                        <span>{formatShortDate(new Date(item.startAt))}</span>
                        <div>
                          <strong>{item.title}</strong>
                          <span>{formatTime(item.startAt, item.allDay)} · {item.driverName || item.linkedCourt || 'General event'}</span>
                        </div>
                      </button>
                    ))}
                    {!memberItems.length ? <p className="workspace-toolbar-copy">No visible events for this team member.</p> : null}
                  </div>
                </article>
              ))}
            </div>
          ) : null}
        </div>

        <aside className="legal-calendar-detail card">
          {panelMode === 'day' ? (
            <div className="legal-calendar-panel-stack">
              <header className="legal-calendar-panel-header">
                <div>
                  <p className="section-eyebrow">Day Detail</p>
                  <h2 className="section-title">{formatLongDate(focusedDate)}</h2>
                </div>
                <button type="button" className="button-link secondary" onClick={() => handleCreateForDate(focusedDate)}>
                  Quick Create
                </button>
              </header>
              <div className="legal-calendar-day-summary">
                <div>
                  <strong>{selectedDayItems.length}</strong>
                  <span>Booked items</span>
                </div>
                <div>
                  <strong>{dayGaps.length}</strong>
                  <span>Open windows</span>
                </div>
                <div>
                  <strong>{getAvailabilityForDate(preferences, focusedDate).enabled ? `${getAvailabilityForDate(preferences, focusedDate).start} - ${getAvailabilityForDate(preferences, focusedDate).end}` : 'Off day'}</strong>
                  <span>Working hours</span>
                </div>
              </div>
              <div className="legal-calendar-panel-block">
                <h3>Booked times</h3>
                {selectedDayItems.length ? (
                  <div className="legal-calendar-panel-list">
                    {selectedDayItems.map((item) => (
                      <button key={item.id} type="button" className="legal-calendar-panel-row" onClick={() => openEvent(item)}>
                        <span className={`legal-calendar-badge tone-${item.colorKey}`}>{getCalendarEventTypeMeta(item.eventType).label}</span>
                        <div>
                          <strong>{item.title}</strong>
                          <span>{formatTime(item.startAt, item.allDay)} - {formatTime(item.endAt, item.allDay)} · {item.ownerLabel}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="workspace-toolbar-copy">Nothing booked yet. This is an open day for hearings, calls, or document review.</p>
                )}
              </div>
              <div className="legal-calendar-panel-block">
                <h3>Open gaps</h3>
                {dayGaps.length ? (
                  <div className="legal-calendar-gap-list">
                    {dayGaps.map((gap) => (
                      <button
                        key={`${gap.start.toISOString()}-${gap.end.toISOString()}`}
                        type="button"
                        className="legal-calendar-gap-row"
                        onClick={() => handleCreateForDate(gap.start)}
                      >
                        <strong>{formatTime(gap.start.toISOString())} - {formatTime(gap.end.toISOString())}</strong>
                        <span>Create event in this window</span>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="workspace-toolbar-copy">No open windows in configured working hours.</p>
                )}
              </div>
            </div>
          ) : null}

          {panelMode === 'event' && selectedEvent ? (
            <div className="legal-calendar-panel-stack">
              <header className="legal-calendar-panel-header">
                <div>
                  <p className="section-eyebrow">Event Detail</p>
                  <h2 className="section-title">{selectedEvent.title}</h2>
                </div>
                <button type="button" className="button-link secondary" onClick={() => openDraft(buildDraftFromItem(selectedEvent))}>
                  Edit
                </button>
              </header>
              <div className="legal-calendar-event-meta">
                <span className={`legal-calendar-badge tone-${selectedEvent.colorKey}`}>{getCalendarEventTypeMeta(selectedEvent.eventType).label}</span>
                <span>{selectedEvent.status}</span>
                <span>{selectedEvent.visibility}</span>
              </div>
              <dl className="legal-calendar-detail-list">
                <div><dt>Date</dt><dd>{formatLongDate(new Date(selectedEvent.startAt))}</dd></div>
                <div><dt>Time</dt><dd>{formatTime(selectedEvent.startAt, selectedEvent.allDay)} - {formatTime(selectedEvent.endAt, selectedEvent.allDay)}</dd></div>
                <div><dt>Duration</dt><dd>{formatDurationMinutes(selectedEvent.startAt, selectedEvent.endAt, selectedEvent.allDay)}</dd></div>
                <div><dt>Assigned</dt><dd>{selectedEvent.ownerLabel}</dd></div>
                <div><dt>Case</dt><dd>{selectedEvent.caseId ? (caseById.get(selectedEvent.caseId)?.citationNumber || selectedEvent.caseId) : 'Not case-linked'}</dd></div>
                <div><dt>Driver / Client</dt><dd>{selectedEvent.driverName || '-'}</dd></div>
                <div><dt>Fleet</dt><dd>{selectedEvent.fleetName || '-'}</dd></div>
                <div><dt>Court</dt><dd>{selectedEvent.linkedCourt || selectedEvent.linkedCounty || '-'}</dd></div>
                <div><dt>Location</dt><dd>{selectedEvent.location || '-'}</dd></div>
                <div><dt>Reminders</dt><dd>{selectedEvent.reminderOffsets.length ? selectedEvent.reminderOffsets.map((offset) => `${offset}m`).join(', ') : 'None'}</dd></div>
              </dl>
              {warningsById.get(selectedEvent.id)?.length ? (
                <div className="legal-calendar-warning-list">
                  {warningsById.get(selectedEvent.id)?.map((warning) => (
                    <span key={warning} className="legal-calendar-warning-pill">
                      {warning}
                    </span>
                  ))}
                </div>
              ) : null}
              {selectedEvent.notes ? (
                <div className="legal-calendar-panel-block">
                  <h3>Notes</h3>
                  <p>{selectedEvent.notes}</p>
                </div>
              ) : null}
              <div className="legal-calendar-action-stack">
                {selectedEvent.caseId ? (
                  <Link href={`/cases/${selectedEvent.caseId}?return_to=${encodeURIComponent(currentReturnTo)}`} className="button-link secondary">
                    Open Linked Case
                  </Link>
                ) : null}
                {selectedEvent.sourceKind !== 'case_court' || calendarStorageAvailable ? (
                  <CalendarActionForm action={duplicateAttorneyCalendarItem}>
                    <input type="hidden" name="return_to" value={currentReturnTo} />
                    <input type="hidden" name="source_kind" value={selectedEvent.sourceKind} />
                    <input type="hidden" name="item_id" value={selectedEvent.id} />
                    <input type="hidden" name="case_id" value={selectedEvent.caseId ?? ''} />
                    <button type="submit" className="button-link secondary">
                      Duplicate
                    </button>
                  </CalendarActionForm>
                ) : null}
                {selectedEvent.sourceKind !== 'case_court' ? (
                  <CalendarActionForm action={completeAttorneyCalendarItem}>
                    <input type="hidden" name="return_to" value={currentReturnTo} />
                    <input type="hidden" name="source_kind" value={selectedEvent.sourceKind} />
                    <input type="hidden" name="item_id" value={selectedEvent.id} />
                    <input type="hidden" name="case_id" value={selectedEvent.caseId ?? ''} />
                    <button type="submit" className="button-link secondary">
                      Mark Complete
                    </button>
                  </CalendarActionForm>
                ) : null}
                <CalendarActionForm action={deleteAttorneyCalendarItem}>
                  <input type="hidden" name="return_to" value={currentReturnTo} />
                  <input type="hidden" name="source_kind" value={selectedEvent.sourceKind} />
                  <input type="hidden" name="item_id" value={selectedEvent.sourceKind === 'case_court' ? (selectedEvent.caseId ?? selectedEvent.id) : selectedEvent.id} />
                  <input type="hidden" name="case_id" value={selectedEvent.caseId ?? ''} />
                  <button type="submit" className="button-link danger">
                    {selectedEvent.sourceKind === 'case_court' ? 'Clear Court Date' : 'Delete'}
                  </button>
                </CalendarActionForm>
              </div>
            </div>
          ) : null}

          {panelMode === 'compose' && draft ? (
            <div className="legal-calendar-panel-stack">
              <header className="legal-calendar-panel-header">
                <div>
                  <p className="section-eyebrow">{draft.itemId ? 'Edit Event' : 'Create Event'}</p>
                  <h2 className="section-title">{draft.itemId ? 'Update calendar item' : 'Schedule new item'}</h2>
                </div>
              </header>
              {!calendarStorageAvailable ? (
                <p className="workspace-toolbar-copy">
                  Calendar-only event storage is not available until the attorney calendar migration is applied. Task-like reminders and case court edits still work.
                </p>
              ) : null}
              <form action={saveAttorneyCalendarItem} className="legal-calendar-form">
                <input type="hidden" name="return_to" value={currentReturnTo} />
                <input type="hidden" name="source_kind" value={draft.sourceKind} />
                <input type="hidden" name="item_id" value={draft.itemId} />
                <input type="hidden" name="sync_case_court" value={draft.syncCaseCourt ? '1' : '0'} />
                <label>
                  <span>Title</span>
                  <input name="title" defaultValue={draft.title} placeholder="Morgan County hearing prep" required />
                </label>
                <label>
                  <span>Event Type</span>
                  <select name="event_type" defaultValue={draft.eventType}>
                    {CALENDAR_EVENT_TYPE_OPTIONS.filter((option) => calendarStorageAvailable || option.storage === 'task').map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Start Date</span>
                    <input name="start_date" type="date" defaultValue={draft.startDate} required />
                  </label>
                  <label>
                    <span>Start Time</span>
                    <input name="start_time" type="time" defaultValue={draft.startTime} disabled={draft.allDay} />
                  </label>
                  <label>
                    <span>End Date</span>
                    <input name="end_date" type="date" defaultValue={draft.endDate} required />
                  </label>
                  <label>
                    <span>End Time</span>
                    <input name="end_time" type="time" defaultValue={draft.endTime} disabled={draft.allDay} />
                  </label>
                </div>
                <label className="legal-calendar-inline-toggle">
                  <input type="checkbox" name="all_day" value="1" defaultChecked={draft.allDay} />
                  <span>All day</span>
                </label>
                <label>
                  <span>Linked Case</span>
                  <select name="case_id" defaultValue={draft.caseId}>
                    <option value="">Not case-linked</option>
                    {cases.map((caseOption) => (
                      <option key={caseOption.id} value={caseOption.id}>
                        {caseOption.citationNumber || caseOption.id.slice(0, 8)} - {caseOption.driverName}
                      </option>
                    ))}
                  </select>
                </label>
                {draft.caseId && caseById.get(draft.caseId) ? (
                  <div className="legal-calendar-case-link-card">
                    <strong>{caseById.get(draft.caseId)?.driverName}</strong>
                    <span>{caseById.get(draft.caseId)?.fleetName || 'No fleet assigned'} · {caseById.get(draft.caseId)?.courtName || 'Court not set'}</span>
                  </div>
                ) : null}
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Assigned To</span>
                    <select name="assigned_user_id" defaultValue={draft.assignedUserId}>
                      {firmMembers.map((member) => (
                        <option key={member.userId} value={member.userId}>
                          {member.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Visibility</span>
                    <select name="visibility" defaultValue={draft.visibility}>
                      <option value="SHARED">Shared</option>
                      <option value="PRIVATE">Private</option>
                    </select>
                  </label>
                  <label>
                    <span>Status</span>
                    <select name="status" defaultValue={draft.status}>
                      <option value="SCHEDULED">Scheduled</option>
                      <option value="TENTATIVE">Tentative</option>
                      <option value="COMPLETED">Completed</option>
                      <option value="CANCELLED">Cancelled</option>
                    </select>
                  </label>
                  <label>
                    <span>Reminder Offsets</span>
                    <input name="reminder_offsets_csv" defaultValue={draft.reminderOffsetsCsv} placeholder="1440, 120, 30" />
                  </label>
                </div>
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Linked Court</span>
                    <input name="linked_court" defaultValue={draft.linkedCourt} placeholder="Morgan County Court" />
                  </label>
                  <label>
                    <span>State</span>
                    <input name="linked_state" defaultValue={draft.linkedState} placeholder="WV" />
                  </label>
                  <label>
                    <span>County</span>
                    <input name="linked_county" defaultValue={draft.linkedCounty} placeholder="Morgan" />
                  </label>
                  <label>
                    <span>Location / Court Address</span>
                    <input name="location" defaultValue={draft.location} placeholder="123 Court St" />
                  </label>
                </div>
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Virtual Meeting Link</span>
                    <input name="meeting_url" defaultValue={draft.meetingUrl} placeholder="https://..." />
                  </label>
                  <label>
                    <span>Reference Link</span>
                    <input name="reference_link" defaultValue={draft.referenceLink} placeholder="Case portal or docket link" />
                  </label>
                  <label>
                    <span>Prep Buffer (min)</span>
                    <input name="prep_before_minutes" type="number" min="0" defaultValue={draft.prepBeforeMinutes} />
                  </label>
                  <label>
                    <span>Travel Before (min)</span>
                    <input name="travel_before_minutes" type="number" min="0" defaultValue={draft.travelBeforeMinutes} />
                  </label>
                  <label>
                    <span>Travel After (min)</span>
                    <input name="travel_after_minutes" type="number" min="0" defaultValue={draft.travelAfterMinutes} />
                  </label>
                </div>
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Recurrence</span>
                    <select name="recurrence_frequency" defaultValue={draft.recurrenceFrequency}>
                      <option value="NONE">Does not repeat</option>
                      <option value="DAILY">Daily</option>
                      <option value="WEEKLY">Weekly</option>
                      <option value="MONTHLY">Monthly</option>
                    </select>
                  </label>
                  <label>
                    <span>Repeat Every</span>
                    <input name="recurrence_interval" type="number" min="1" defaultValue={draft.recurrenceInterval} />
                  </label>
                  <label>
                    <span>Repeat Until</span>
                    <input name="recurrence_until" type="date" defaultValue={draft.recurrenceUntil} />
                  </label>
                  <label>
                    <span>Occurrences</span>
                    <input name="recurrence_count" type="number" min="1" defaultValue={draft.recurrenceCount} />
                  </label>
                </div>
                <label>
                  <span>Notes</span>
                  <textarea name="notes" defaultValue={draft.notes} rows={5} placeholder="Prep instructions, filing notes, or court-specific details" />
                </label>
                <div className="legal-calendar-submit-row">
                  <CalendarSubmitButton label={draft.itemId ? 'Save Changes' : 'Create Event'} />
                  <button type="button" className="button-link secondary" onClick={() => { setDraft(null); setPanelMode(draft.itemId ? 'event' : 'day') }}>
                    Close
                  </button>
                </div>
              </form>
            </div>
          ) : null}

          {panelMode === 'availability' ? (
            <div className="legal-calendar-panel-stack">
              <header className="legal-calendar-panel-header">
                <div>
                  <p className="section-eyebrow">Availability</p>
                  <h2 className="section-title">Working hours and defaults</h2>
                </div>
              </header>
              <form action={saveAttorneyCalendarPreferences} className="legal-calendar-form">
                <input type="hidden" name="return_to" value={currentReturnTo} />
                <label>
                  <span>Timezone</span>
                  <input name="timezone" defaultValue={preferences.timezone} />
                </label>
                <div className="legal-calendar-form-grid">
                  <label>
                    <span>Hearing Duration</span>
                    <input name="hearing_duration_minutes" type="number" min="15" defaultValue={preferences.hearingDurationMinutes} />
                  </label>
                  <label>
                    <span>Prep Buffer</span>
                    <input name="prep_buffer_minutes" type="number" min="0" defaultValue={preferences.prepBufferMinutes} />
                  </label>
                  <label>
                    <span>Travel Buffer</span>
                    <input name="travel_buffer_minutes" type="number" min="0" defaultValue={preferences.travelBufferMinutes} />
                  </label>
                  <label>
                    <span>Notice Window</span>
                    <input name="notice_window_days" type="number" min="1" defaultValue={preferences.noticeWindowDays} />
                  </label>
                </div>
                <label>
                  <span>Default Reminder Offsets</span>
                  <input name="reminder_defaults_csv" defaultValue={preferences.reminderDefaults.join(', ')} />
                </label>
                <div className="legal-calendar-availability-grid">
                  {(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((day) => {
                    const availability = preferences.workingHours[day]
                    return (
                      <div key={day} className="legal-calendar-availability-row">
                        <strong>{day.toUpperCase()}</strong>
                        <label className="legal-calendar-inline-toggle">
                          <input name={`${day}_enabled`} type="checkbox" value="1" defaultChecked={availability?.enabled ?? false} />
                          <span>Enabled</span>
                        </label>
                        <input name={`${day}_start`} type="time" defaultValue={availability?.start ?? '08:00'} />
                        <input name={`${day}_end`} type="time" defaultValue={availability?.end ?? '17:00'} />
                      </div>
                    )
                  })}
                </div>
                <CalendarSubmitButton label="Save Availability" />
              </form>
            </div>
          ) : null}
        </aside>
      </section>
    </div>
  )
}

