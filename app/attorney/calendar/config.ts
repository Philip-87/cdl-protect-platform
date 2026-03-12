export const CALENDAR_EVENT_TYPE_OPTIONS = [
  { value: 'COURT_APPEARANCE', label: 'Court Appearance', family: 'hearing', storage: 'calendar', defaultDuration: 60, defaultAllDay: false, color: 'court', defaultReminderOffsets: [1440, 120] },
  { value: 'HEARING', label: 'Hearing', family: 'hearing', storage: 'calendar', defaultDuration: 60, defaultAllDay: false, color: 'hearing', defaultReminderOffsets: [1440, 120] },
  { value: 'FILING_DEADLINE', label: 'Filing Deadline', family: 'deadline', storage: 'task', defaultDuration: 30, defaultAllDay: true, color: 'deadline', defaultReminderOffsets: [1440, 240] },
  { value: 'INTERNAL_DEADLINE', label: 'Internal Deadline', family: 'deadline', storage: 'task', defaultDuration: 30, defaultAllDay: true, color: 'deadline', defaultReminderOffsets: [1440, 120] },
  { value: 'REMINDER', label: 'Reminder', family: 'task', storage: 'task', defaultDuration: 15, defaultAllDay: false, color: 'reminder', defaultReminderOffsets: [60, 15] },
  { value: 'FOLLOW_UP', label: 'Follow-Up', family: 'task', storage: 'task', defaultDuration: 30, defaultAllDay: false, color: 'followup', defaultReminderOffsets: [1440, 60] },
  { value: 'CLIENT_CALL', label: 'Client Call', family: 'communication', storage: 'calendar', defaultDuration: 30, defaultAllDay: false, color: 'call', defaultReminderOffsets: [60, 15] },
  { value: 'ATTORNEY_CALL', label: 'Attorney Call', family: 'communication', storage: 'calendar', defaultDuration: 30, defaultAllDay: false, color: 'call', defaultReminderOffsets: [60, 15] },
  { value: 'DOCUMENT_REVIEW', label: 'Document Review', family: 'task', storage: 'task', defaultDuration: 45, defaultAllDay: false, color: 'review', defaultReminderOffsets: [60] },
  { value: 'INTAKE_CONSULTATION', label: 'Intake Consultation', family: 'meeting', storage: 'calendar', defaultDuration: 45, defaultAllDay: false, color: 'meeting', defaultReminderOffsets: [1440, 60] },
  { value: 'PAYMENT_REMINDER', label: 'Payment Reminder', family: 'task', storage: 'task', defaultDuration: 15, defaultAllDay: false, color: 'billing', defaultReminderOffsets: [1440, 120] },
  { value: 'TRAVEL_TIME', label: 'Travel Time', family: 'travel', storage: 'calendar', defaultDuration: 60, defaultAllDay: false, color: 'travel', defaultReminderOffsets: [60] },
  { value: 'BLOCKED_TIME', label: 'Blocked Time', family: 'availability', storage: 'calendar', defaultDuration: 60, defaultAllDay: false, color: 'blocked', defaultReminderOffsets: [] },
  { value: 'PERSONAL', label: 'Personal / Private Event', family: 'availability', storage: 'calendar', defaultDuration: 60, defaultAllDay: false, color: 'private', defaultReminderOffsets: [60] },
  { value: 'STAFF_MEETING', label: 'Staff Meeting', family: 'meeting', storage: 'calendar', defaultDuration: 45, defaultAllDay: false, color: 'meeting', defaultReminderOffsets: [60, 15] },
  { value: 'CASE_PREP', label: 'Case Prep', family: 'task', storage: 'task', defaultDuration: 60, defaultAllDay: false, color: 'prep', defaultReminderOffsets: [1440, 120] },
  { value: 'TRIAL_PREP', label: 'Trial Prep', family: 'task', storage: 'task', defaultDuration: 90, defaultAllDay: false, color: 'prep', defaultReminderOffsets: [1440, 240] },
  { value: 'ADMIN_TASK', label: 'Administrative Task', family: 'task', storage: 'task', defaultDuration: 30, defaultAllDay: false, color: 'admin', defaultReminderOffsets: [60] },
] as const

export type CalendarEventTypeValue = (typeof CALENDAR_EVENT_TYPE_OPTIONS)[number]['value']

export const CALENDAR_VIEW_OPTIONS = ['month', 'week', 'day', 'agenda', 'case', 'team'] as const
export type AttorneyCalendarView = (typeof CALENDAR_VIEW_OPTIONS)[number]

export function getCalendarEventTypeMeta(value: string | null | undefined) {
  const normalized = String(value ?? '').trim().toUpperCase()
  return CALENDAR_EVENT_TYPE_OPTIONS.find((option) => option.value === normalized) ?? CALENDAR_EVENT_TYPE_OPTIONS[4]
}

export function isTaskLikeCalendarEventType(value: string | null | undefined) {
  return getCalendarEventTypeMeta(value).storage === 'task'
}

export function isCalendarView(value: string | null | undefined): value is AttorneyCalendarView {
  return CALENDAR_VIEW_OPTIONS.includes(String(value ?? '').trim().toLowerCase() as AttorneyCalendarView)
}
