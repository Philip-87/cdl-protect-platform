import test from 'node:test'
import assert from 'node:assert/strict'
import { hashBrowserFile, issueOcrPreviewToken, verifyOcrPreviewToken } from '../app/lib/server/ocr-preview-token.ts'

test('issues and verifies OCR preview tokens for the same user and file hash', async () => {
  const previousSecret = process.env.OCR_PREVIEW_TOKEN_SECRET
  process.env.OCR_PREVIEW_TOKEN_SECRET = 'preview-secret'

  try {
    const fileHash = await hashBrowserFile(new File(['ticket'], 'ticket.txt', { type: 'text/plain' }))
    const token = issueOcrPreviewToken({
      userId: 'user-1',
      fileHash,
      confidence: 0.91,
      fields: { ticket: 'A123' },
    })

    assert.ok(token)

    const verified = verifyOcrPreviewToken(token, 'user-1')
    assert.equal(verified.ok, true)
    if (!verified.ok) return

    assert.equal(verified.payload.fileHash, fileHash)
    assert.equal(verified.payload.confidence, 0.91)
    assert.deepEqual(verified.payload.fields, { ticket: 'A123' })
  } finally {
    process.env.OCR_PREVIEW_TOKEN_SECRET = previousSecret
  }
})

test('rejects OCR preview tokens for the wrong user', async () => {
  const previousSecret = process.env.OCR_PREVIEW_TOKEN_SECRET
  process.env.OCR_PREVIEW_TOKEN_SECRET = 'preview-secret'

  try {
    const token = issueOcrPreviewToken({
      userId: 'user-1',
      fileHash: 'abc123',
      confidence: 0.75,
      fields: {},
    })

    const verified = verifyOcrPreviewToken(token, 'user-2')
    assert.equal(verified.ok, false)
    if (verified.ok) return
    assert.match(verified.message, /does not belong/i)
  } finally {
    process.env.OCR_PREVIEW_TOKEN_SECRET = previousSecret
  }
})

test('does not fall back to cron or service-role secrets for OCR preview tokens', () => {
  const previousPreviewSecret = process.env.OCR_PREVIEW_TOKEN_SECRET
  const previousAuthSecret = process.env.AUTH_SECRET
  const previousNextAuthSecret = process.env.NEXTAUTH_SECRET
  const previousCronSecret = process.env.CRON_SECRET
  const previousServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  delete process.env.OCR_PREVIEW_TOKEN_SECRET
  delete process.env.AUTH_SECRET
  delete process.env.NEXTAUTH_SECRET
  process.env.CRON_SECRET = 'cron-secret-only'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-only'

  try {
    const token = issueOcrPreviewToken({
      userId: 'user-1',
      fileHash: 'abc123',
      confidence: 0.5,
      fields: {},
    })

    assert.equal(token, '')

    const verified = verifyOcrPreviewToken('missing.signature', 'user-1')
    assert.equal(verified.ok, false)
    if (verified.ok) return
    assert.match(verified.message, /not configured/i)
  } finally {
    if (previousPreviewSecret === undefined) delete process.env.OCR_PREVIEW_TOKEN_SECRET
    else process.env.OCR_PREVIEW_TOKEN_SECRET = previousPreviewSecret
    if (previousAuthSecret === undefined) delete process.env.AUTH_SECRET
    else process.env.AUTH_SECRET = previousAuthSecret
    if (previousNextAuthSecret === undefined) delete process.env.NEXTAUTH_SECRET
    else process.env.NEXTAUTH_SECRET = previousNextAuthSecret
    if (previousCronSecret === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = previousCronSecret
    if (previousServiceRoleKey === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY
    else process.env.SUPABASE_SERVICE_ROLE_KEY = previousServiceRoleKey
  }
})
