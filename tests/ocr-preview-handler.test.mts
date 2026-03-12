import test from 'node:test'
import assert from 'node:assert/strict'
import { handleOcrPreviewRequest } from '../app/api/intake/ocr-preview/handler.ts'

function buildFormData(file?: File) {
  const formData = new FormData()
  if (file) {
    formData.append('file', file)
  }
  return formData
}

test('rejects unauthenticated OCR preview requests', async () => {
  let called = false

  const result = await handleOcrPreviewRequest({
    userId: null,
    formData: buildFormData(new File(['ticket'], 'ticket.txt', { type: 'text/plain' })),
    runOcrFromFile: async () => {
      called = true
      return { ok: true, confidence: 1, fields: {}, raw: null }
    },
  })

  assert.equal(result.status, 401)
  assert.deepEqual(result.body, { ok: false, error: 'Unauthorized' })
  assert.equal(called, false)
})

test('validates file is provided', async () => {
  let called = false

  const result = await handleOcrPreviewRequest({
    userId: 'user-1',
    formData: buildFormData(),
    runOcrFromFile: async () => {
      called = true
      return { ok: true, confidence: 1, fields: {}, raw: null }
    },
  })

  assert.equal(result.status, 400)
  assert.deepEqual(result.body, { ok: false, error: 'File is required.' })
  assert.equal(called, false)
})

test('returns OCR payload on success', async () => {
  const fields = { citation: 'A1234' }

  const result = await handleOcrPreviewRequest({
    userId: 'user-1',
    formData: buildFormData(new File(['ticket'], 'ticket.pdf', { type: 'application/pdf' })),
    runOcrFromFile: async () => ({
      ok: true,
      confidence: 0.87,
      fields,
      raw: { provider: 'nanonets' },
    }),
  })

  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {
    ok: true,
    confidence: 0.87,
    fields,
  })
})

test('returns OCR error payload when extraction fails', async () => {
  const raw = { reason: 'timeout' }

  const result = await handleOcrPreviewRequest({
    userId: 'user-1',
    formData: buildFormData(new File(['ticket'], 'ticket.png', { type: 'image/png' })),
    runOcrFromFile: async () => ({
      ok: false,
      confidence: 0,
      fields: {},
      raw,
      error: 'OCR timed out',
    }),
  })

  assert.equal(result.status, 200)
  assert.deepEqual(result.body, {
    ok: false,
    error: 'OCR timed out',
    raw,
  })
})

test('rejects oversized OCR preview files', async () => {
  let called = false
  const file = new File([new Uint8Array(12 * 1024 * 1024 + 1)], 'ticket.pdf', { type: 'application/pdf' })

  const result = await handleOcrPreviewRequest({
    userId: 'user-1',
    formData: buildFormData(file),
    runOcrFromFile: async () => {
      called = true
      return { ok: true, confidence: 1, fields: {}, raw: null }
    },
  })

  assert.equal(result.status, 400)
  assert.deepEqual(result.body, { ok: false, error: 'File exceeds 12MB limit.' })
  assert.equal(called, false)
})

test('rejects unsupported OCR preview MIME types', async () => {
  let called = false

  const result = await handleOcrPreviewRequest({
    userId: 'user-1',
    formData: buildFormData(new File(['ticket'], 'ticket.txt', { type: 'text/plain' })),
    runOcrFromFile: async () => {
      called = true
      return { ok: true, confidence: 1, fields: {}, raw: null }
    },
  })

  assert.equal(result.status, 400)
  assert.deepEqual(result.body, { ok: false, error: 'File must be a PDF or image upload.' })
  assert.equal(called, false)
})
