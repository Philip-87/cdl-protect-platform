export type CalendarConnectionSummary = {
  emailConnected: boolean
  emailLabel: string
  emailAddress: string
  calendarConnected: boolean
  calendarAddress: string
  calendarProvider: 'GOOGLE' | 'MICROSOFT' | null
  calendarStatus: 'CONNECTED' | 'PENDING' | 'ERROR' | 'DISCONNECTED' | null
  calendarError: string | null
  lastCalendarSyncAt: string | null
}

export type CalendarCaseOption = {
  id: string
  citationNumber: string | null
  state: string
  county: string | null
  courtName: string | null
  courtAddress: string | null
  courtDate: string | null
  courtTime: string | null
  driverName: string
  fleetName: string | null
  status: string
}

export type CalendarFirmMember = {
  userId: string
  label: string
  email: string | null
  roleInFirm: string | null
  isCurrentUser: boolean
}

export type CalendarAvailabilityDay = {
  enabled: boolean
  start: string
  end: string
}

export type CalendarPreferences = {
  timezone: string
  workingHours: Record<string, CalendarAvailabilityDay>
  hearingDurationMinutes: number
  prepBufferMinutes: number
  travelBufferMinutes: number
  reminderDefaults: number[]
  noticeWindowDays: number
}

export type AttorneyCalendarItem = {
  id: string
  sourceKind: 'case_court' | 'task' | 'calendar'
  caseId: string | null
  title: string
  eventType: string
  family: string
  colorKey: string
  startAt: string
  endAt: string
  allDay: boolean
  location: string | null
  meetingUrl: string | null
  notes: string | null
  status: string
  visibility: 'PRIVATE' | 'SHARED'
  ownerUserId: string | null
  ownerLabel: string
  assignedUserId: string | null
  reminderOffsets: number[]
  prepBeforeMinutes: number
  travelBeforeMinutes: number
  travelAfterMinutes: number
  linkedCourt: string | null
  linkedState: string | null
  linkedCounty: string | null
  citationNumber: string | null
  driverName: string | null
  fleetName: string | null
  caseStatus: string | null
  metadata: Record<string, unknown> | null
}
