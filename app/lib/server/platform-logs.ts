'use server'

import { createServiceRoleClient } from '@/app/lib/supabase/service-role'

type PlatformLogSeverity = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

type PlatformLogEntry = {
  severity?: PlatformLogSeverity
  eventType: string
  source: string
  message: string
  actorUserId?: string | null
  targetUserId?: string | null
  requestPath?: string | null
  metadata?: Record<string, unknown> | null
}

export async function writePlatformLog(entry: PlatformLogEntry) {
  try {
    const admin = createServiceRoleClient()
    await admin.from('platform_logs').insert({
      severity: entry.severity ?? 'INFO',
      event_type: entry.eventType,
      source: entry.source,
      message: entry.message,
      actor_user_id: entry.actorUserId ?? null,
      target_user_id: entry.targetUserId ?? null,
      request_path: entry.requestPath ?? null,
      metadata: entry.metadata ?? {},
    })
  } catch {
    // Never block user flows on logging failures.
  }
}

