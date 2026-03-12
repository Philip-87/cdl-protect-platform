import { NextResponse } from 'next/server'
import { runWorkerBatch } from '@/app/lib/server/job-worker'
import { handleCronWorkerRequest } from './handler'

const CRON_SECRET = String(process.env.CRON_SECRET ?? '').trim()

async function run(request: Request) {
  try {
    const result = await handleCronWorkerRequest({
      method: request.method,
      url: request.url,
      headers: request.headers,
      cronSecret: CRON_SECRET,
      runBatch: runWorkerBatch,
    })

    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Worker execution failed.',
      },
      { status: 500 }
    )
  }
}

export async function POST(request: Request) {
  return run(request)
}
