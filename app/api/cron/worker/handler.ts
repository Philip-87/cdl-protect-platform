import type { WorkerBatchResult } from '@/app/lib/server/job-worker'

function getProvidedSecret(headers: Headers) {
  const headerSecret = String(headers.get('x-cron-secret') ?? '').trim()
  if (headerSecret) return headerSecret

  const authHeader = String(headers.get('authorization') ?? '').trim()
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)
  return bearer?.[1]?.trim() || ''
}

function parseJobTypes(url: URL) {
  const values: string[] = []

  const repeated = url.searchParams.getAll('job_type')
  values.push(...repeated)

  const csv = String(url.searchParams.get('job_types') ?? '')
  if (csv) values.push(...csv.split(','))

  return values.map((value) => value.trim().toUpperCase()).filter(Boolean)
}

export type CronWorkerResponse = {
  status: number
  body:
    | ({ ok: true } & WorkerBatchResult)
    | { ok: false; error: string }
}

export async function handleCronWorkerRequest(params: {
  method: string
  url: string
  headers: Headers
  cronSecret: string
  runBatch: (params: { limit: number; jobTypes: string[] | null; workerId?: string }) => Promise<WorkerBatchResult>
}) {
  if (params.method !== 'POST') {
    return {
      status: 405,
      body: {
        ok: false,
        error: 'Method not allowed.',
      },
    } satisfies CronWorkerResponse
  }

  if (!params.cronSecret) {
    return {
      status: 500,
      body: {
        ok: false,
        error: 'CRON_SECRET is not configured.',
      },
    } satisfies CronWorkerResponse
  }

  const providedSecret = getProvidedSecret(params.headers)
  if (!providedSecret || providedSecret !== params.cronSecret) {
    return {
      status: 401,
      body: {
        ok: false,
        error: 'Unauthorized',
      },
    } satisfies CronWorkerResponse
  }

  const url = new URL(params.url)
  const rawLimit = Number(url.searchParams.get('limit') || '10')
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(Math.trunc(rawLimit), 50)) : 10
  const jobTypes = parseJobTypes(url)
  const workerId = String(url.searchParams.get('worker_id') ?? '').trim() || undefined

  const result = await params.runBatch({
    limit,
    jobTypes: jobTypes.length ? jobTypes : null,
    workerId,
  })

  return {
    status: 200,
    body: {
      ok: true as const,
      ...result,
    },
  } satisfies CronWorkerResponse
}
