import type { SupabaseClient } from '@supabase/supabase-js'

type RpcClient = Pick<SupabaseClient, 'rpc'>

function parseRpcUuid(data: unknown) {
  if (typeof data === 'string') return data
  if (Array.isArray(data) && typeof data[0] === 'string') return data[0]

  if (data && typeof data === 'object') {
    const maybeRecord = data as Record<string, unknown>
    for (const key of ['enqueue_case_job', 'job_id', 'id']) {
      const value = maybeRecord[key]
      if (typeof value === 'string' && value) return value
    }
  }

  return ''
}

export async function enqueueDocumentOcrJob(
  supabase: RpcClient,
  params: {
    caseId: string
    documentId: string
    storagePath: string
    requestedBy: string
    source: 'INTAKE_UPLOAD' | 'CASE_UPLOAD' | 'OCR_RERUN'
  }
) {
  const dedupeKey = `OCR_PROCESS_DOCUMENT:${params.documentId}`
  const rpc = await supabase.rpc('enqueue_case_job', {
    p_job_type: 'OCR_PROCESS_DOCUMENT',
    p_case_id: params.caseId,
    p_document_id: params.documentId,
    p_payload: {
      case_id: params.caseId,
      document_id: params.documentId,
      storage_path: params.storagePath,
      requested_by: params.requestedBy,
      source: params.source,
    },
    p_priority: 25,
    p_max_attempts: 5,
    p_dedupe_key: dedupeKey,
  })

  if (rpc.error) {
    return {
      ok: false as const,
      jobId: null,
      message: rpc.error.message,
    }
  }

  const jobId = parseRpcUuid(rpc.data)
  if (!jobId) {
    return {
      ok: false as const,
      jobId: null,
      message: 'Queue did not return a valid job id.',
    }
  }

  return {
    ok: true as const,
    jobId,
    message: '',
  }
}
