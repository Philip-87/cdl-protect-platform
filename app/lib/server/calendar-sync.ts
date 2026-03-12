import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { decryptCalendarSecret, encryptCalendarSecret } from '@/app/lib/server/calendar-sync-crypto'
import {
  loadCalendarIntegrationsForUser,
  loadCalendarPlatformItem,
  platformEventKey,
  type AttorneyCalendarIntegrationRow,
  type CalendarItemRef,
  type CalendarPlatformItem,
} from '@/app/lib/server/attorney-calendar-runtime'
import { getAppBaseUrl } from '@/app/lib/server/stripe'

type JsonRecord = Record<string, unknown>

export type CalendarProvider = 'GOOGLE' | 'MICROSOFT'

type TokenEnvelope = { token: string }

type ProviderTokenResult = {
  accessToken: string
  refreshToken: string | null
  expiresAt: string | null
  scope: string[]
}

type CalendarProviderProfile = {
  accountEmail: string | null
  displayName: string | null
  calendarId: string
}

type ExternalCalendarEvent = {
  externalEventId: string
  title: string
  description: string | null
  startAt: string
  endAt: string
  allDay: boolean
  location: string | null
  visibility: 'PRIVATE' | 'SHARED'
  status: string
  updatedAt: string | null
  platformEventKey: string | null
  raw: JsonRecord
}

type ExternalEventMappingRow = {
  id: string
  integration_id: string
  external_event_id: string
  platform_event_kind: 'calendar' | 'task' | 'case_court'
  platform_event_key: string
  provider_event_hash: string | null
  platform_event_hash: string | null
}

const GOOGLE_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/calendar',
] as const

const MICROSOFT_SCOPES = [
  'offline_access',
  'openid',
  'email',
  'profile',
  'User.Read',
  'Calendars.ReadWrite',
] as const

const CDL_PROTECT_REF_MARKER = 'CDL Protect Ref:'
const IMPORT_LOOKBACK_DAYS = 30
const IMPORT_LOOKAHEAD_DAYS = 180

function getSiteUrl() {
  const baseUrl = getAppBaseUrl()
  if (!baseUrl) {
    throw new Error('APP_URL or NEXT_PUBLIC_SITE_URL must be configured for calendar sync.')
  }
  return baseUrl
}

function getMetadataRecord(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as JsonRecord) : {}
}

function getGoogleClientConfig() {
  return {
    clientId: String(process.env.GOOGLE_CLIENT_ID ?? '').trim(),
    clientSecret: String(process.env.GOOGLE_CLIENT_SECRET ?? '').trim(),
    redirectUri:
      String(process.env.GOOGLE_CALENDAR_REDIRECT_URI ?? '').trim() ||
      `${getSiteUrl()}/api/integrations/google-calendar/callback`,
  }
}

function getMicrosoftClientConfig() {
  const tenantId = String(process.env.MICROSOFT_TENANT_ID ?? '').trim() || 'common'
  return {
    clientId: String(process.env.MICROSOFT_CLIENT_ID ?? '').trim(),
    clientSecret: String(process.env.MICROSOFT_CLIENT_SECRET ?? '').trim(),
    tenantId,
    redirectUri:
      String(process.env.MICROSOFT_CALENDAR_REDIRECT_URI ?? '').trim() ||
      `${getSiteUrl()}/api/integrations/microsoft-calendar/callback`,
  }
}

function decryptToken(encryptedValue: string | null) {
  const value = String(encryptedValue ?? '').trim()
  if (!value) return null
  const payload = decryptCalendarSecret<TokenEnvelope>(value)
  return String(payload.token ?? '').trim() || null
}

function encryptToken(token: string | null | undefined) {
  const value = String(token ?? '').trim()
  if (!value) return null
  return encryptCalendarSecret({ token: value })
}

function parseIsoOrNull(value: string | null | undefined) {
  const raw = String(value ?? '').trim()
  if (!raw) return null
  const date = new Date(raw)
  return Number.isNaN(+date) ? null : date
}

function sha256(value: string) {
  return createHash('sha256').update(value).digest('hex')
}

function buildExternalEventHash(input: ExternalCalendarEvent) {
  return sha256(
    JSON.stringify({
      title: input.title,
      startAt: input.startAt,
      endAt: input.endAt,
      allDay: input.allDay,
      location: input.location,
      visibility: input.visibility,
      status: input.status,
      updatedAt: input.updatedAt,
    })
  )
}

function buildPlatformEventHash(item: CalendarPlatformItem) {
  return sha256(
    JSON.stringify({
      platformEventKey: item.platformEventKey,
      title: item.title,
      eventType: item.eventType,
      startAt: item.startAt,
      endAt: item.endAt,
      allDay: item.allDay,
      location: item.location,
      visibility: item.visibility,
      status: item.status,
      referenceLink: item.referenceLink,
      caseId: item.caseId,
      citationNumber: item.citationNumber,
    })
  )
}

function buildPlatformDescription(item: CalendarPlatformItem) {
  const lines = [
    item.caseId ? `Case ID: ${item.caseId}` : '',
    item.citationNumber ? `Citation: ${item.citationNumber}` : '',
    item.linkedCourt ? `Court: ${item.linkedCourt}` : '',
    item.linkedCounty ? `County: ${item.linkedCounty}` : '',
    item.linkedState ? `State: ${item.linkedState}` : '',
    item.referenceLink ? `Reference: ${item.referenceLink}` : '',
    item.notes ? `Notes: ${item.notes}` : '',
    `${CDL_PROTECT_REF_MARKER} ${item.platformEventKey}`,
  ].filter(Boolean)

  return lines.join('\n')
}

function extractPlatformEventKey(value: string | null | undefined) {
  const raw = String(value ?? '')
  const match = raw.match(/CDL Protect Ref:\s*([a-z_]+:[a-zA-Z0-9-]+)/i)
  return match?.[1]?.trim() || null
}

function buildGoogleAuthUrl(state: string) {
  const config = getGoogleClientConfig()
  if (!config.clientId || !config.clientSecret) {
    throw new Error('GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be configured.')
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    scope: GOOGLE_SCOPES.join(' '),
    state,
  })

  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

function buildMicrosoftAuthUrl(state: string) {
  const config = getMicrosoftClientConfig()
  if (!config.clientId || !config.clientSecret) {
    throw new Error('MICROSOFT_CLIENT_ID and MICROSOFT_CLIENT_SECRET must be configured.')
  }

  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    response_mode: 'query',
    scope: MICROSOFT_SCOPES.join(' '),
    state,
  })

  return `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/authorize?${params.toString()}`
}

async function parseTokenResponse(response: Response) {
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(
      String(json?.error_description ?? json?.error ?? `OAuth token request failed (${response.status}).`)
    )
  }
  return json
}

async function exchangeGoogleCode(code: string): Promise<ProviderTokenResult> {
  const config = getGoogleClientConfig()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: 'authorization_code',
    }),
    cache: 'no-store',
  })
  const payload = await parseTokenResponse(response)

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: String(payload.refresh_token ?? '').trim() || null,
    expiresAt:
      Number.isFinite(Number(payload.expires_in))
        ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString()
        : null,
    scope: String(payload.scope ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

async function refreshGoogleToken(refreshToken: string): Promise<ProviderTokenResult> {
  const config = getGoogleClientConfig()
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      grant_type: 'refresh_token',
    }),
    cache: 'no-store',
  })
  const payload = await parseTokenResponse(response)

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken,
    expiresAt:
      Number.isFinite(Number(payload.expires_in))
        ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString()
        : null,
    scope: String(payload.scope ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

async function exchangeMicrosoftCode(code: string): Promise<ProviderTokenResult> {
  const config = getMicrosoftClientConfig()
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
        grant_type: 'authorization_code',
        scope: MICROSOFT_SCOPES.join(' '),
      }),
      cache: 'no-store',
    }
  )
  const payload = await parseTokenResponse(response)

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: String(payload.refresh_token ?? '').trim() || null,
    expiresAt:
      Number.isFinite(Number(payload.expires_in))
        ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString()
        : null,
    scope: String(payload.scope ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

async function refreshMicrosoftToken(refreshToken: string): Promise<ProviderTokenResult> {
  const config = getMicrosoftClientConfig()
  const response = await fetch(
    `https://login.microsoftonline.com/${config.tenantId}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        refresh_token: refreshToken,
        grant_type: 'refresh_token',
        scope: MICROSOFT_SCOPES.join(' '),
      }),
      cache: 'no-store',
    }
  )
  const payload = await parseTokenResponse(response)

  return {
    accessToken: String(payload.access_token ?? ''),
    refreshToken: String(payload.refresh_token ?? '').trim() || refreshToken,
    expiresAt:
      Number.isFinite(Number(payload.expires_in))
        ? new Date(Date.now() + Number(payload.expires_in) * 1000).toISOString()
        : null,
    scope: String(payload.scope ?? '')
      .split(/\s+/)
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

async function fetchGoogleProfile(accessToken: string): Promise<CalendarProviderProfile> {
  const profileRes = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const json = (await profileRes.json().catch(() => null)) as JsonRecord | null
  if (!profileRes.ok || !json) {
    throw new Error(String(json?.error_description ?? json?.error ?? 'Could not load Google profile.'))
  }

  return {
    accountEmail: String(json.email ?? '').trim() || null,
    displayName: String(json.name ?? '').trim() || null,
    calendarId: 'primary',
  }
}

async function fetchMicrosoftProfile(accessToken: string): Promise<CalendarProviderProfile> {
  const profileRes = await fetch('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName,displayName', {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const json = (await profileRes.json().catch(() => null)) as JsonRecord | null
  if (!profileRes.ok || !json) {
    throw new Error(String(json?.error_description ?? json?.error ?? 'Could not load Microsoft profile.'))
  }

  return {
    accountEmail:
      String(json.mail ?? '').trim() ||
      String(json.userPrincipalName ?? '').trim() ||
      null,
    displayName: String(json.displayName ?? '').trim() || null,
    calendarId: 'primary',
  }
}

function encodeGoogleEventDate(input: CalendarPlatformItem) {
  if (!input.allDay) {
    return {
      start: { dateTime: input.startAt, timeZone: 'UTC' },
      end: { dateTime: input.endAt, timeZone: 'UTC' },
    }
  }

  const start = parseIsoOrNull(input.startAt) ?? new Date()
  const end = parseIsoOrNull(input.endAt) ?? start
  const exclusiveEnd = new Date(
    Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate() + 1)
  )

  return {
    start: { date: start.toISOString().slice(0, 10) },
    end: { date: exclusiveEnd.toISOString().slice(0, 10) },
  }
}

function toMicrosoftDateTime(value: string) {
  const date = new Date(value)
  return {
    dateTime: [
      date.getUTCFullYear(),
      String(date.getUTCMonth() + 1).padStart(2, '0'),
      String(date.getUTCDate()).padStart(2, '0'),
    ].join('-') +
      'T' +
      [
        String(date.getUTCHours()).padStart(2, '0'),
        String(date.getUTCMinutes()).padStart(2, '0'),
        String(date.getUTCSeconds()).padStart(2, '0'),
      ].join(':'),
    timeZone: 'UTC',
  }
}

function buildGoogleEventPayload(item: CalendarPlatformItem) {
  const datePart = encodeGoogleEventDate(item)
  return {
    summary: item.title,
    description: buildPlatformDescription(item),
    location: item.location || undefined,
    visibility: item.visibility === 'PRIVATE' ? 'private' : 'default',
    reminders: { useDefault: false },
    extendedProperties: {
      private: {
        cdlProtectRef: item.platformEventKey,
        caseId: item.caseId || '',
      },
    },
    ...datePart,
  }
}

function buildMicrosoftEventPayload(item: CalendarPlatformItem) {
  const description = buildPlatformDescription(item)
  return {
    subject: item.title,
    body: {
      contentType: 'text',
      content: description,
    },
    start: toMicrosoftDateTime(item.startAt),
    end: toMicrosoftDateTime(item.endAt),
    isAllDay: item.allDay,
    location: item.location ? { displayName: item.location } : undefined,
    sensitivity: item.visibility === 'PRIVATE' ? 'private' : 'normal',
    showAs: ['BLOCKED_TIME', 'PERSONAL'].includes(item.eventType) ? 'busy' : 'busy',
  }
}

function getMetadataDate(value: unknown) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord).date
    : null
}

function getDateTimeFromGoogle(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as JsonRecord
  const dateTime = String(record.dateTime ?? '').trim()
  if (dateTime) return new Date(dateTime).toISOString()
  const date = String(record.date ?? '').trim()
  if (!date) return null
  return new Date(`${date}T00:00:00Z`).toISOString()
}

async function listGoogleEvents(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string
): Promise<ExternalCalendarEvent[]> {
  const now = new Date()
  const timeMin = new Date(now.getTime() - IMPORT_LOOKBACK_DAYS * 86400000).toISOString()
  const timeMax = new Date(now.getTime() + IMPORT_LOOKAHEAD_DAYS * 86400000).toISOString()
  const url = new URL(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.provider_calendar_id || 'primary')}/events`
  )
  url.searchParams.set('singleEvents', 'true')
  url.searchParams.set('showDeleted', 'true')
  url.searchParams.set('maxResults', '2500')
  url.searchParams.set('timeMin', timeMin)
  url.searchParams.set('timeMax', timeMax)

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(String((getMetadataRecord(json?.error).message ?? json?.error ?? 'Google Calendar list failed.')))
  }

  const items = Array.isArray(json.items) ? (json.items as JsonRecord[]) : []
  return items
    .map((row) => {
      const startDate = getDateTimeFromGoogle(row.start)
      const endDate = getDateTimeFromGoogle(row.end)
      if (!startDate || !endDate) return null
      const description = String(row.description ?? '').trim() || null
      return {
        externalEventId: String(row.id ?? '').trim(),
        title: String(row.summary ?? 'Busy').trim() || 'Busy',
        description,
        startAt: startDate,
        endAt: endDate,
        allDay: Boolean(getMetadataDate(row.start)),
        location: String(row.location ?? '').trim() || null,
        visibility: String(row.visibility ?? '').trim().toLowerCase() === 'private' ? 'PRIVATE' : 'SHARED',
        status: String(row.status ?? 'confirmed').trim().toUpperCase(),
        updatedAt: String(row.updated ?? '').trim() || null,
        platformEventKey:
          String((getMetadataRecord(getMetadataRecord(row.extendedProperties).private).cdlProtectRef ?? '')).trim() ||
          extractPlatformEventKey(description),
        raw: row,
      } satisfies ExternalCalendarEvent
    })
    .filter((row): row is ExternalCalendarEvent => Boolean(row?.externalEventId))
}

async function createGoogleEvent(integration: AttorneyCalendarIntegrationRow, accessToken: string, item: CalendarPlatformItem) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.provider_calendar_id || 'primary')}/events`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildGoogleEventPayload(item)),
      cache: 'no-store',
    }
  )
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(String((getMetadataRecord(json?.error).message ?? json?.error ?? 'Google Calendar create failed.')))
  }
  return json
}

async function updateGoogleEvent(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string,
  externalEventId: string,
  item: CalendarPlatformItem
) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.provider_calendar_id || 'primary')}/events/${encodeURIComponent(externalEventId)}`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(buildGoogleEventPayload(item)),
      cache: 'no-store',
    }
  )
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(String((getMetadataRecord(json?.error).message ?? json?.error ?? 'Google Calendar update failed.')))
  }
  return json
}

async function deleteGoogleEvent(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string,
  externalEventId: string
) {
  const response = await fetch(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(integration.provider_calendar_id || 'primary')}/events/${encodeURIComponent(externalEventId)}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: 'no-store',
    }
  )
  if (!response.ok && response.status !== 404) {
    const json = (await response.json().catch(() => null)) as JsonRecord | null
    throw new Error(String((getMetadataRecord(json?.error).message ?? json?.error ?? 'Google Calendar delete failed.')))
  }
}

function normalizeMicrosoftDateTime(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as JsonRecord
  const dateTime = String(record.dateTime ?? '').trim()
  if (!dateTime) return null
  const normalized = dateTime.endsWith('Z') ? dateTime : `${dateTime}Z`
  return new Date(normalized).toISOString()
}

async function listMicrosoftEvents(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string
): Promise<ExternalCalendarEvent[]> {
  const now = new Date()
  const startDateTime = new Date(now.getTime() - IMPORT_LOOKBACK_DAYS * 86400000).toISOString()
  const endDateTime = new Date(now.getTime() + IMPORT_LOOKAHEAD_DAYS * 86400000).toISOString()
  const url = new URL('https://graph.microsoft.com/v1.0/me/calendar/calendarView')
  url.searchParams.set('startDateTime', startDateTime)
  url.searchParams.set('endDateTime', endDateTime)
  url.searchParams.set('$top', '1000')
  url.searchParams.set('$select', 'id,subject,bodyPreview,body,start,end,location,sensitivity,showAs,isAllDay,lastModifiedDateTime')

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(String((getMetadataRecord(getMetadataRecord(json).error).message ?? json?.error ?? 'Microsoft Calendar list failed.')))
  }

  const values = Array.isArray(json.value) ? (json.value as JsonRecord[]) : []
  return values
    .map((row) => {
      const startAt = normalizeMicrosoftDateTime(row.start)
      const endAt = normalizeMicrosoftDateTime(row.end)
      if (!startAt || !endAt) return null
      const description =
        String((getMetadataRecord(row.body).content ?? '') || '').trim() ||
        String(row.bodyPreview ?? '').trim() ||
        null
      return {
        externalEventId: String(row.id ?? '').trim(),
        title: String(row.subject ?? 'Busy').trim() || 'Busy',
        description,
        startAt,
        endAt,
        allDay: Boolean(row.isAllDay),
        location: String(getMetadataRecord(row.location).displayName ?? '').trim() || null,
        visibility: String(row.sensitivity ?? '').trim().toLowerCase() === 'private' ? 'PRIVATE' : 'SHARED',
        status: 'CONFIRMED',
        updatedAt: String(row.lastModifiedDateTime ?? '').trim() || null,
        platformEventKey: extractPlatformEventKey(description),
        raw: row,
      } satisfies ExternalCalendarEvent
    })
    .filter((row): row is ExternalCalendarEvent => Boolean(row?.externalEventId))
}

async function createMicrosoftEvent(accessToken: string, item: CalendarPlatformItem) {
  const response = await fetch('https://graph.microsoft.com/v1.0/me/events', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildMicrosoftEventPayload(item)),
    cache: 'no-store',
  })
  const json = (await response.json().catch(() => null)) as JsonRecord | null
  if (!response.ok || !json) {
    throw new Error(String((getMetadataRecord(getMetadataRecord(json).error).message ?? json?.error ?? 'Microsoft Calendar create failed.')))
  }
  return json
}

async function updateMicrosoftEvent(accessToken: string, externalEventId: string, item: CalendarPlatformItem) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildMicrosoftEventPayload(item)),
    cache: 'no-store',
  })
  if (!response.ok) {
    const json = (await response.json().catch(() => null)) as JsonRecord | null
    throw new Error(String((getMetadataRecord(getMetadataRecord(json).error).message ?? json?.error ?? 'Microsoft Calendar update failed.')))
  }
  return { id: externalEventId }
}

async function deleteMicrosoftEvent(accessToken: string, externalEventId: string) {
  const response = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(externalEventId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${accessToken}` },
    cache: 'no-store',
  })
  if (!response.ok && response.status !== 404) {
    const json = (await response.json().catch(() => null)) as JsonRecord | null
    throw new Error(String((getMetadataRecord(getMetadataRecord(json).error).message ?? json?.error ?? 'Microsoft Calendar delete failed.')))
  }
}

async function getFreshAccessToken(
  supabase: SupabaseClient,
  integration: AttorneyCalendarIntegrationRow
) {
  const accessToken = decryptToken(integration.access_token_encrypted)
  const refreshToken = decryptToken(integration.refresh_token_encrypted)
  const expiresAt = parseIsoOrNull(integration.token_expires_at)
  const stillValid = accessToken && (!expiresAt || +expiresAt > Date.now() + 5 * 60 * 1000)
  if (stillValid) {
    return { accessToken, integration }
  }

  if (!refreshToken) {
    throw new Error(`${integration.provider} refresh token is missing.`)
  }

  const refreshed =
    integration.provider === 'GOOGLE'
      ? await refreshGoogleToken(refreshToken)
      : await refreshMicrosoftToken(refreshToken)

  const nextEncryptedAccess = encryptToken(refreshed.accessToken)
  const nextEncryptedRefresh = encryptToken(refreshed.refreshToken)
  const update = await supabase
    .from('attorney_calendar_integrations')
    .update({
      access_token_encrypted: nextEncryptedAccess,
      refresh_token_encrypted: nextEncryptedRefresh,
      token_expires_at: refreshed.expiresAt,
      granted_scopes: refreshed.scope,
      last_sync_status: 'CONNECTED',
      last_sync_error: null,
      updated_at: new Date().toISOString(),
    })
    .eq('id', integration.id)

  if (update.error) {
    throw new Error(update.error.message)
  }

  return {
    accessToken: refreshed.accessToken,
    integration: {
      ...integration,
      access_token_encrypted: nextEncryptedAccess || integration.access_token_encrypted,
      refresh_token_encrypted: nextEncryptedRefresh,
      token_expires_at: refreshed.expiresAt,
      granted_scopes: refreshed.scope,
    },
  }
}

async function loadCalendarIntegrationById(supabase: SupabaseClient, integrationId: string) {
  const integrationRes = await supabase
    .from('attorney_calendar_integrations')
    .select(
      'id, user_id, provider, provider_account_email, provider_calendar_id, access_token_encrypted, refresh_token_encrypted, token_expires_at, granted_scopes, sync_enabled, import_external_events, export_platform_events, sync_direction, last_sync_at, last_sync_status, last_sync_error, metadata'
    )
    .eq('id', integrationId)
    .maybeSingle<AttorneyCalendarIntegrationRow>()

  if (integrationRes.error || !integrationRes.data) {
    throw new Error(integrationRes.error?.message || 'Calendar integration not found.')
  }

  return integrationRes.data
}

async function persistExternalMapping(
  supabase: SupabaseClient,
  params: {
    integrationId: string
    provider: CalendarProvider
    externalEventId: string
    externalCalendarId?: string | null
    platformEventKind: 'calendar' | 'task' | 'case_court'
    platformEventKey: string
    syncDirection: 'IMPORT' | 'EXPORT' | 'BIDIRECTIONAL'
    providerEventHash: string | null
    platformEventHash: string | null
    remoteUpdatedAt: string | null
    rawPayload: JsonRecord
  }
) {
  const existing = await supabase
    .from('attorney_calendar_external_events')
    .select('id')
    .eq('integration_id', params.integrationId)
    .eq('external_event_id', params.externalEventId)
    .maybeSingle<{ id: string }>()

  const payload = {
    integration_id: params.integrationId,
    provider: params.provider,
    external_event_id: params.externalEventId,
    external_calendar_id: params.externalCalendarId || 'primary',
    platform_event_kind: params.platformEventKind,
    platform_event_key: params.platformEventKey,
    sync_direction: params.syncDirection,
    provider_event_hash: params.providerEventHash,
    platform_event_hash: params.platformEventHash,
    remote_updated_at: params.remoteUpdatedAt,
    last_synced_at: new Date().toISOString(),
    raw_payload: params.rawPayload,
  }

  if (!existing.error && existing.data?.id) {
    const update = await supabase
      .from('attorney_calendar_external_events')
      .update(payload)
      .eq('id', existing.data.id)
    if (update.error) throw new Error(update.error.message)
    return
  }

  const insert = await supabase.from('attorney_calendar_external_events').insert(payload)
  if (insert.error) throw new Error(insert.error.message)
}

async function updateIntegrationStatus(
  supabase: SupabaseClient,
  integrationId: string,
  patch: Partial<Pick<AttorneyCalendarIntegrationRow, 'last_sync_status' | 'last_sync_error' | 'last_sync_at' | 'metadata'>>
) {
  const update = await supabase
    .from('attorney_calendar_integrations')
    .update({
      ...patch,
      updated_at: new Date().toISOString(),
    })
    .eq('id', integrationId)
  if (update.error) {
    throw new Error(update.error.message)
  }
}

function guessImportedEventType(event: ExternalCalendarEvent) {
  const haystack = `${event.title} ${event.description ?? ''}`.toLowerCase()
  if (haystack.includes('court') || haystack.includes('hearing')) return 'HEARING'
  if (haystack.includes('deadline') || haystack.includes('filing') || haystack.includes('due')) return 'INTERNAL_DEADLINE'
  if (haystack.includes('travel')) return 'TRAVEL_TIME'
  if (haystack.includes('call')) return 'CLIENT_CALL'
  if (event.visibility === 'PRIVATE') return 'PERSONAL'
  return 'BLOCKED_TIME'
}

async function loadMappingsByExternalId(
  supabase: SupabaseClient,
  integrationId: string,
  externalIds: string[]
) {
  if (!externalIds.length) return new Map<string, ExternalEventMappingRow>()
  const res = await supabase
    .from('attorney_calendar_external_events')
    .select('id, integration_id, external_event_id, platform_event_kind, platform_event_key, provider_event_hash, platform_event_hash')
    .eq('integration_id', integrationId)
    .in('external_event_id', externalIds)

  const map = new Map<string, ExternalEventMappingRow>()
  for (const row of ((res.data ?? []) as ExternalEventMappingRow[])) {
    map.set(row.external_event_id, row)
  }
  return map
}

async function loadMappingsByPlatformKey(
  supabase: SupabaseClient,
  integrationId: string,
  platformKeys: string[]
) {
  if (!platformKeys.length) return new Map<string, ExternalEventMappingRow>()
  const res = await supabase
    .from('attorney_calendar_external_events')
    .select('id, integration_id, external_event_id, platform_event_kind, platform_event_key, provider_event_hash, platform_event_hash')
    .eq('integration_id', integrationId)
    .in('platform_event_key', platformKeys)

  const map = new Map<string, ExternalEventMappingRow>()
  for (const row of ((res.data ?? []) as ExternalEventMappingRow[])) {
    map.set(row.platform_event_key, row)
  }
  return map
}

async function loadItemsForFullExport(supabase: SupabaseClient, userId: string) {
  const now = new Date()
  const rangeStart = new Date(now.getTime() - IMPORT_LOOKBACK_DAYS * 86400000).toISOString()
  const rangeEnd = new Date(now.getTime() + IMPORT_LOOKAHEAD_DAYS * 86400000).toISOString()
  const refs: CalendarItemRef[] = []

  const calendarEventsRes = await supabase
    .from('attorney_calendar_events')
    .select('id')
    .or(`owner_user_id.eq.${userId},assigned_user_id.eq.${userId}`)
    .gte('end_at', rangeStart)
    .lte('start_at', rangeEnd)
    .limit(1000)
  for (const row of ((calendarEventsRes.data ?? []) as Array<{ id: string }>)) {
    refs.push({ sourceKind: 'calendar', itemId: row.id })
  }

  const tasksRes = await supabase
    .from('case_tasks')
    .select('id')
    .or(`target_user_id.eq.${userId},requested_by_user_id.eq.${userId}`)
    .not('due_at', 'is', null)
    .gte('due_at', rangeStart)
    .lte('due_at', rangeEnd)
    .limit(1000)
  for (const row of ((tasksRes.data ?? []) as Array<{ id: string }>)) {
    refs.push({ sourceKind: 'task', itemId: row.id })
  }

  const caseRes = await supabase
    .from('cases')
    .select('id')
    .eq('assigned_attorney_user_id', userId)
    .not('court_date', 'is', null)
    .gte('court_date', rangeStart.slice(0, 10))
    .lte('court_date', rangeEnd.slice(0, 10))
    .limit(1000)
  for (const row of ((caseRes.data ?? []) as Array<{ id: string }>)) {
    refs.push({ sourceKind: 'case_court', itemId: row.id })
  }

  const uniqueRefs = [...new Map(refs.map((ref) => [platformEventKey(ref), ref])).values()]
  const items = await Promise.all(uniqueRefs.map((ref) => loadCalendarPlatformItem(supabase, ref)))
  return items.filter((item): item is CalendarPlatformItem => Boolean(item))
}

async function providerListEvents(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string
) {
  return integration.provider === 'GOOGLE'
    ? listGoogleEvents(integration, accessToken)
    : listMicrosoftEvents(integration, accessToken)
}

async function providerCreateEvent(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string,
  item: CalendarPlatformItem
) {
  return integration.provider === 'GOOGLE'
    ? createGoogleEvent(integration, accessToken, item)
    : createMicrosoftEvent(accessToken, item)
}

async function providerUpdateEvent(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string,
  externalEventId: string,
  item: CalendarPlatformItem
) {
  return integration.provider === 'GOOGLE'
    ? updateGoogleEvent(integration, accessToken, externalEventId, item)
    : updateMicrosoftEvent(accessToken, externalEventId, item)
}

async function providerDeleteEvent(
  integration: AttorneyCalendarIntegrationRow,
  accessToken: string,
  externalEventId: string
) {
  return integration.provider === 'GOOGLE'
    ? deleteGoogleEvent(integration, accessToken, externalEventId)
    : deleteMicrosoftEvent(accessToken, externalEventId)
}

export function buildCalendarConnectUrl(provider: CalendarProvider, state: string) {
  return provider === 'GOOGLE' ? buildGoogleAuthUrl(state) : buildMicrosoftAuthUrl(state)
}

export async function exchangeCalendarProviderCode(provider: CalendarProvider, code: string) {
  return provider === 'GOOGLE' ? exchangeGoogleCode(code) : exchangeMicrosoftCode(code)
}

export async function fetchCalendarProviderProfile(provider: CalendarProvider, accessToken: string) {
  return provider === 'GOOGLE' ? fetchGoogleProfile(accessToken) : fetchMicrosoftProfile(accessToken)
}

export async function upsertCalendarIntegration(params: {
  supabase: SupabaseClient
  userId: string
  provider: CalendarProvider
  accountEmail: string | null
  calendarId?: string | null
  tokens: ProviderTokenResult
  metadata?: JsonRecord
}) {
  const existing = await params.supabase
    .from('attorney_calendar_integrations')
    .select('id')
    .eq('user_id', params.userId)
    .eq('provider', params.provider)
    .maybeSingle<{ id: string }>()

  const payload = {
    user_id: params.userId,
    provider: params.provider,
    provider_account_email: params.accountEmail,
    provider_calendar_id: params.calendarId || 'primary',
    access_token_encrypted: encryptToken(params.tokens.accessToken),
    refresh_token_encrypted: encryptToken(params.tokens.refreshToken),
    token_expires_at: params.tokens.expiresAt,
    granted_scopes: params.tokens.scope,
    sync_enabled: true,
    import_external_events: true,
    export_platform_events: true,
    sync_direction: 'BIDIRECTIONAL',
    last_sync_status: 'CONNECTED',
    last_sync_error: null,
    last_sync_at: new Date().toISOString(),
    metadata: params.metadata ?? {},
  }

  if (!existing.error && existing.data?.id) {
    const update = await params.supabase
      .from('attorney_calendar_integrations')
      .update(payload)
      .eq('id', existing.data.id)
      .select('id')
      .single<{ id: string }>()
    if (update.error || !update.data?.id) {
      throw new Error(update.error?.message || 'Could not update calendar integration.')
    }
    return update.data.id
  }

  const insert = await params.supabase
    .from('attorney_calendar_integrations')
    .insert(payload)
    .select('id')
    .single<{ id: string }>()
  if (insert.error || !insert.data?.id) {
    throw new Error(insert.error?.message || 'Could not create calendar integration.')
  }
  return insert.data.id
}

export async function updateAttorneyIntegrationMetadata(
  supabase: SupabaseClient,
  params: {
    userId: string
    provider: CalendarProvider
    calendarEmail: string | null
  }
) {
  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, metadata')
    .eq('user_id', params.userId)
    .maybeSingle<{ id: string; metadata: JsonRecord | null }>()

  if (profileRes.error || !profileRes.data?.id) {
    return
  }

  const metadata = profileRes.data.metadata ?? {}
  const integrationsRaw = metadata['integrations']
  const integrations =
    integrationsRaw && typeof integrationsRaw === 'object' && !Array.isArray(integrationsRaw)
      ? { ...(integrationsRaw as JsonRecord) }
      : {}

  const connectedAt = new Date().toISOString()
  const nextMetadata = {
    ...metadata,
    integrations: {
      ...integrations,
      calendar_provider: params.provider,
      calendar_email: params.calendarEmail,
      calendar_connected_at: connectedAt,
      google_calendar_email: params.provider === 'GOOGLE' ? params.calendarEmail : integrations['google_calendar_email'] ?? null,
      google_calendar_enabled: params.provider === 'GOOGLE' ? true : Boolean(integrations['google_calendar_enabled']),
      google_calendar_connected_at:
        params.provider === 'GOOGLE'
          ? connectedAt
          : integrations['google_calendar_connected_at'] ?? null,
      microsoft_calendar_email: params.provider === 'MICROSOFT' ? params.calendarEmail : integrations['microsoft_calendar_email'] ?? null,
      microsoft_calendar_enabled: params.provider === 'MICROSOFT' ? true : Boolean(integrations['microsoft_calendar_enabled']),
      microsoft_calendar_connected_at:
        params.provider === 'MICROSOFT'
          ? connectedAt
          : integrations['microsoft_calendar_connected_at'] ?? null,
    },
  }

  await supabase
    .from('attorney_onboarding_profiles')
    .update({ metadata: nextMetadata })
    .eq('id', profileRes.data.id)
}

export async function clearAttorneyCalendarIntegrationMetadata(
  supabase: SupabaseClient,
  params: {
    userId: string
    provider: CalendarProvider
  }
) {
  const profileRes = await supabase
    .from('attorney_onboarding_profiles')
    .select('id, metadata')
    .eq('user_id', params.userId)
    .maybeSingle<{ id: string; metadata: JsonRecord | null }>()

  if (profileRes.error || !profileRes.data?.id) {
    return
  }

  const metadata = profileRes.data.metadata ?? {}
  const integrationsRaw = metadata['integrations']
  const integrations =
    integrationsRaw && typeof integrationsRaw === 'object' && !Array.isArray(integrationsRaw)
      ? { ...(integrationsRaw as JsonRecord) }
      : {}

  const currentProvider = String(integrations['calendar_provider'] ?? '').trim().toUpperCase()
  const nextIntegrations: JsonRecord = {
    ...integrations,
  }

  if (params.provider === 'GOOGLE') {
    nextIntegrations.google_calendar_email = null
    nextIntegrations.google_calendar_enabled = false
    nextIntegrations.google_calendar_connected_at = null
  } else {
    nextIntegrations.microsoft_calendar_email = null
    nextIntegrations.microsoft_calendar_enabled = false
    nextIntegrations.microsoft_calendar_connected_at = null
  }

  if (currentProvider === params.provider) {
    nextIntegrations.calendar_provider = null
    nextIntegrations.calendar_email = null
    nextIntegrations.calendar_connected_at = null
  }

  await supabase
    .from('attorney_onboarding_profiles')
    .update({
      metadata: {
        ...metadata,
        integrations: nextIntegrations,
      },
    })
    .eq('id', profileRes.data.id)
}

export async function disconnectCalendarIntegration(
  supabase: SupabaseClient,
  params: { userId: string; integrationId: string }
) {
  const integration = await loadCalendarIntegrationById(supabase, params.integrationId)
  if (integration.user_id !== params.userId) {
    throw new Error('Calendar integration does not belong to this user.')
  }

  const remove = await supabase
    .from('attorney_calendar_integrations')
    .delete()
    .eq('id', params.integrationId)
  if (remove.error) {
    throw new Error(remove.error.message)
  }
}

export async function syncExternalCalendarImport(
  supabase: SupabaseClient,
  params: { integrationId: string }
) {
  const integration = await loadCalendarIntegrationById(supabase, params.integrationId)
  if (!integration.sync_enabled || !integration.import_external_events || integration.sync_direction === 'EXPORT_ONLY') {
    return { imported: 0, updated: 0, skipped: 0 }
  }

  const { accessToken } = await getFreshAccessToken(supabase, integration)

  try {
    const externalEvents = await providerListEvents(integration, accessToken)
    const mappingByExternalId = await loadMappingsByExternalId(
      supabase,
      integration.id,
      externalEvents.map((item) => item.externalEventId)
    )

    let imported = 0
    let updated = 0
    let skipped = 0

    for (const externalEvent of externalEvents) {
      const providerEventHash = buildExternalEventHash(externalEvent)
      const existingMapping = mappingByExternalId.get(externalEvent.externalEventId)
      const mappedPlatformKey = existingMapping?.platform_event_key || externalEvent.platformEventKey

      if (mappedPlatformKey && !mappedPlatformKey.startsWith('calendar:')) {
        await persistExternalMapping(supabase, {
          integrationId: integration.id,
          provider: integration.provider,
          externalEventId: externalEvent.externalEventId,
          platformEventKind: mappedPlatformKey.split(':')[0] as 'task' | 'case_court' | 'calendar',
          platformEventKey: mappedPlatformKey,
          syncDirection: 'EXPORT',
          providerEventHash,
          platformEventHash: existingMapping?.platform_event_hash ?? null,
          remoteUpdatedAt: externalEvent.updatedAt,
          rawPayload: externalEvent.raw,
        })
        skipped += 1
        continue
      }

      if (externalEvent.status === 'CANCELLED' && existingMapping?.platform_event_key.startsWith('calendar:')) {
        const calendarId = existingMapping.platform_event_key.slice('calendar:'.length)
        await supabase
          .from('attorney_calendar_events')
          .update({ status: 'CANCELLED' })
          .eq('id', calendarId)
        await persistExternalMapping(supabase, {
          integrationId: integration.id,
          provider: integration.provider,
          externalEventId: externalEvent.externalEventId,
          platformEventKind: 'calendar',
          platformEventKey: existingMapping.platform_event_key,
          syncDirection: 'IMPORT',
          providerEventHash,
          platformEventHash: existingMapping.platform_event_hash ?? null,
          remoteUpdatedAt: externalEvent.updatedAt,
          rawPayload: externalEvent.raw,
        })
        updated += 1
        continue
      }

      const metadata = {
        source: 'EXTERNAL_CALENDAR_SYNC',
        external_provider: integration.provider,
        external_event_id: externalEvent.externalEventId,
      }
      const eventPayload = {
        owner_user_id: integration.user_id,
        assigned_user_id: integration.user_id,
        case_id: null,
        firm_id: null,
        title: externalEvent.title,
        event_type: guessImportedEventType(externalEvent),
        start_at: externalEvent.startAt,
        end_at: externalEvent.endAt,
        all_day: externalEvent.allDay,
        location: externalEvent.location,
        visibility: externalEvent.visibility,
        status: externalEvent.status === 'CANCELLED' ? 'CANCELLED' : 'SCHEDULED',
        notes: externalEvent.description,
        linked_court: null,
        linked_state: null,
        linked_county: null,
        reminder_offsets: [] as number[],
        prep_before_minutes: 0,
        travel_before_minutes: 0,
        travel_after_minutes: 0,
        metadata,
      }

      let platformKey = mappedPlatformKey || ''
      if (existingMapping?.platform_event_key.startsWith('calendar:')) {
        const calendarId = existingMapping.platform_event_key.slice('calendar:'.length)
        const update = await supabase
          .from('attorney_calendar_events')
          .update(eventPayload)
          .eq('id', calendarId)
        if (update.error) throw new Error(update.error.message)
        platformKey = existingMapping.platform_event_key
        updated += 1
      } else {
        const insert = await supabase
          .from('attorney_calendar_events')
          .insert(eventPayload)
          .select('id')
          .single<{ id: string }>()
        if (insert.error || !insert.data?.id) {
          throw new Error(insert.error?.message || 'Could not import external calendar event.')
        }
        platformKey = `calendar:${insert.data.id}`
        imported += 1
      }

      await persistExternalMapping(supabase, {
        integrationId: integration.id,
        provider: integration.provider,
        externalEventId: externalEvent.externalEventId,
        platformEventKind: 'calendar',
        platformEventKey: platformKey,
        syncDirection: 'IMPORT',
        providerEventHash,
        platformEventHash: null,
        remoteUpdatedAt: externalEvent.updatedAt,
        rawPayload: externalEvent.raw,
      })
    }

    await updateIntegrationStatus(supabase, integration.id, {
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'CONNECTED',
      last_sync_error: null,
    })

    return { imported, updated, skipped }
  } catch (error) {
    await updateIntegrationStatus(supabase, integration.id, {
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'ERROR',
      last_sync_error: error instanceof Error ? error.message : 'Calendar import failed.',
    })
    throw error
  }
}

export async function syncExternalCalendarExport(
  supabase: SupabaseClient,
  params: {
    integrationId: string
    ref?: CalendarItemRef | null
    action?: 'UPSERT' | 'DELETE'
  }
) {
  const integration = await loadCalendarIntegrationById(supabase, params.integrationId)
  if (!integration.sync_enabled || !integration.export_platform_events || integration.sync_direction === 'IMPORT_ONLY') {
    return { created: 0, updated: 0, deleted: 0, skipped: 0 }
  }

  const { accessToken } = await getFreshAccessToken(supabase, integration)

  try {
    const items = params.ref
      ? [await loadCalendarPlatformItem(supabase, params.ref)].filter((item): item is CalendarPlatformItem => Boolean(item))
      : await loadItemsForFullExport(supabase, integration.user_id)

    const platformKeys = items.map((item) => item.platformEventKey)
    const mappingByPlatformKey = await loadMappingsByPlatformKey(supabase, integration.id, platformKeys)

    let created = 0
    let updated = 0
    let deleted = 0
    let skipped = 0

    if (params.ref && (params.action ?? 'UPSERT') === 'DELETE') {
      const mapping = mappingByPlatformKey.get(platformEventKey(params.ref))
      if (mapping?.external_event_id) {
        await providerDeleteEvent(integration, accessToken, mapping.external_event_id)
        await supabase
          .from('attorney_calendar_external_events')
          .delete()
          .eq('integration_id', integration.id)
          .eq('platform_event_key', mapping.platform_event_key)
        deleted += 1
      }

      await updateIntegrationStatus(supabase, integration.id, {
        last_sync_at: new Date().toISOString(),
        last_sync_status: 'CONNECTED',
        last_sync_error: null,
      })
      return { created, updated, deleted, skipped }
    }

    for (const item of items) {
      const isImportedExternal =
        String(item.metadata.source ?? '').trim().toUpperCase() === 'EXTERNAL_CALENDAR_SYNC' &&
        String(item.metadata.external_provider ?? '').trim().toUpperCase() === integration.provider
      if (isImportedExternal) {
        skipped += 1
        continue
      }

      const mapping = mappingByPlatformKey.get(item.platformEventKey)
      const platformHash = buildPlatformEventHash(item)
      const normalizedStatus = String(item.status ?? '').trim().toUpperCase()

      if (['COMPLETED', 'CANCELLED'].includes(normalizedStatus)) {
        if (mapping?.external_event_id) {
          await providerDeleteEvent(integration, accessToken, mapping.external_event_id)
          await supabase
            .from('attorney_calendar_external_events')
            .delete()
            .eq('integration_id', integration.id)
            .eq('platform_event_key', item.platformEventKey)
          deleted += 1
        } else {
          skipped += 1
        }
        continue
      }

      if (mapping && mapping.platform_event_hash === platformHash) {
        skipped += 1
        continue
      }

      const responsePayload =
        mapping?.external_event_id
          ? await providerUpdateEvent(integration, accessToken, mapping.external_event_id, item)
          : await providerCreateEvent(integration, accessToken, item)

      const responseRecord = getMetadataRecord(responsePayload)
      const externalEventId = String(responseRecord.id ?? mapping?.external_event_id ?? '').trim()
      if (!externalEventId) {
        throw new Error(`${integration.provider} sync did not return an event id.`)
      }

      const providerEventHash = sha256(JSON.stringify(responseRecord))
      await persistExternalMapping(supabase, {
        integrationId: integration.id,
        provider: integration.provider,
        externalEventId,
        platformEventKind: item.sourceKind,
        platformEventKey: item.platformEventKey,
        syncDirection: 'EXPORT',
        providerEventHash,
        platformEventHash: platformHash,
        remoteUpdatedAt: String(responseRecord.updated ?? responseRecord.lastModifiedDateTime ?? '').trim() || null,
        rawPayload: responseRecord,
      })

      if (mapping?.external_event_id) updated += 1
      else created += 1
    }

    await updateIntegrationStatus(supabase, integration.id, {
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'CONNECTED',
      last_sync_error: null,
    })

    return { created, updated, deleted, skipped }
  } catch (error) {
    await updateIntegrationStatus(supabase, integration.id, {
      last_sync_at: new Date().toISOString(),
      last_sync_status: 'ERROR',
      last_sync_error: error instanceof Error ? error.message : 'Calendar export failed.',
    })
    throw error
  }
}

export async function getCalendarIntegrationOverview(
  supabase: Pick<SupabaseClient, 'from'>,
  userId: string
) {
  const integrations = await loadCalendarIntegrationsForUser(supabase, userId)
  const byProvider = new Map(integrations.data.map((row) => [row.provider, row]))
  const preferred = byProvider.get('GOOGLE') ?? byProvider.get('MICROSOFT') ?? null

  return {
    integrations: integrations.data,
    missing: integrations.missing,
    error: integrations.error,
    preferred,
  }
}
