import test from 'node:test'
import assert from 'node:assert/strict'
import { handleCronWorkerRequest } from '../app/api/cron/worker/handler.ts'

test('rejects non-POST cron worker requests', async () => {
  const result = await handleCronWorkerRequest({
    method: 'GET',
    url: 'http://localhost:3000/api/cron/worker',
    headers: new Headers(),
    cronSecret: 'secret',
    runBatch: async () => ({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      dead: 0,
      failed: 0,
      jobs: [],
    }),
  })

  assert.equal(result.status, 405)
  assert.deepEqual(result.body, {
    ok: false,
    error: 'Method not allowed.',
  })
})

test('rejects requests without valid cron secret', async () => {
  const result = await handleCronWorkerRequest({
    method: 'POST',
    url: 'http://localhost:3000/api/cron/worker',
    headers: new Headers(),
    cronSecret: 'secret',
    runBatch: async () => ({
      claimed: 0,
      succeeded: 0,
      retried: 0,
      dead: 0,
      failed: 0,
      jobs: [],
    }),
  })

  assert.equal(result.status, 401)
  assert.deepEqual(result.body, {
    ok: false,
    error: 'Unauthorized',
  })
})

test('runs worker batch with parsed limit and job types', async () => {
  const calls: Array<{ limit: number; jobTypes: string[] | null; workerId?: string }> = []

  const result = await handleCronWorkerRequest({
    method: 'POST',
    url: 'http://localhost:3000/api/cron/worker?limit=200&job_types=ocr_process_document,remind_court_date&job_type=escalate_unaccepted_offer&worker_id=ops-1',
    headers: new Headers({
      'x-cron-secret': 'secret',
    }),
    cronSecret: 'secret',
    runBatch: async (params) => {
      calls.push(params)
      return {
        claimed: 3,
        succeeded: 2,
        retried: 1,
        dead: 0,
        failed: 0,
        jobs: [
          { jobId: '1', jobType: 'OCR_PROCESS_DOCUMENT', status: 'SUCCEEDED' },
          { jobId: '2', jobType: 'REMIND_COURT_DATE', status: 'RETRY', error: 'timeout' },
        ],
      }
    },
  })

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    limit: 50,
    jobTypes: ['ESCALATE_UNACCEPTED_OFFER', 'OCR_PROCESS_DOCUMENT', 'REMIND_COURT_DATE'],
    workerId: 'ops-1',
  })

  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {
    ok: true,
    claimed: 3,
    succeeded: 2,
    retried: 1,
    dead: 0,
    failed: 0,
    jobs: [
      { jobId: '1', jobType: 'OCR_PROCESS_DOCUMENT', status: 'SUCCEEDED' },
      { jobId: '2', jobType: 'REMIND_COURT_DATE', status: 'RETRY', error: 'timeout' },
    ],
  })
})
