const baseUrl =
  process.env.WORKER_BASE_URL ||
  process.env.NEXT_PUBLIC_APP_URL ||
  process.env.NEXT_PUBLIC_SITE_URL ||
  'http://localhost:3000'

const cronSecret = String(process.env.CRON_SECRET || '').trim()
if (!cronSecret) {
  console.error('CRON_SECRET is required to run worker script.')
  process.exit(1)
}

const limit = String(process.env.WORKER_BATCH_LIMIT || '10').trim() || '10'
const jobTypes = String(process.env.WORKER_JOB_TYPES || '').trim()
const workerId = String(process.env.WORKER_ID || '').trim()

const url = new URL('/api/cron/worker', baseUrl)
url.searchParams.set('limit', limit)
if (jobTypes) url.searchParams.set('job_types', jobTypes)
if (workerId) url.searchParams.set('worker_id', workerId)

const response = await fetch(url, {
  method: 'POST',
  headers: {
    'x-cron-secret': cronSecret,
    Accept: 'application/json',
  },
})

const body = await response.text()

if (!response.ok) {
  console.error(`Worker request failed (${response.status}): ${body}`)
  process.exit(1)
}

console.log(body)
