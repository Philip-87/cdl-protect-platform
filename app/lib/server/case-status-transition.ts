import type { SupabaseClient } from '@supabase/supabase-js'
import { isValidCaseStatus, type CaseStatus } from '@/app/lib/case-status'

type TransitionRpcRow = {
  previous_status: string
  new_status: string
}

export async function transitionCaseStatus(
  supabase: Pick<SupabaseClient, 'rpc'>,
  params: {
    caseId: string
    toStatus: CaseStatus
    reason?: string | null
    metadata?: Record<string, unknown> | null
  }
) {
  const rpc = await supabase.rpc('transition_case_status', {
    p_case_id: params.caseId,
    p_to_status: params.toStatus,
    p_reason: params.reason ?? null,
    p_metadata: params.metadata ?? null,
  })

  if (rpc.error) {
    return {
      error: rpc.error,
      previousStatus: null as CaseStatus | null,
      newStatus: null as CaseStatus | null,
    }
  }

  const row = (Array.isArray(rpc.data) ? rpc.data[0] : rpc.data) as TransitionRpcRow | null
  const previousStatus = isValidCaseStatus(String(row?.previous_status ?? ''))
    ? row!.previous_status
    : null
  const newStatus = isValidCaseStatus(String(row?.new_status ?? '')) ? row!.new_status : null

  return {
    error: null,
    previousStatus: previousStatus as CaseStatus | null,
    newStatus: newStatus as CaseStatus | null,
  }
}

