import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export type EmailRecipient = {
  email: string
  name?: string
}

function isDev() {
  return process.env.NODE_ENV !== 'production'
}

function getConfig() {
  const apiKey = String(process.env.RESEND_API_KEY ?? '').trim()
  const from = String(process.env.EMAIL_FROM ?? '').trim()
  return { apiKey, from }
}

async function writeDevEmailPreview(params: {
  to: string[]
  subject: string
  html: string
  text?: string
  reason: string
}) {
  try {
    const outboxDir = path.join(process.cwd(), 'tmp')
    const outboxPath = path.join(outboxDir, 'email-outbox.jsonl')
    await mkdir(outboxDir, { recursive: true })
    await appendFile(
      outboxPath,
      `${JSON.stringify({
        createdAt: new Date().toISOString(),
        reason: params.reason,
        to: params.to,
        subject: params.subject,
        html: params.html,
        text: params.text ?? '',
      })}\n`,
      'utf8'
    )
    return outboxPath
  } catch {
    return null
  }
}

export async function sendEmail(params: {
  to: EmailRecipient[]
  subject: string
  html: string
  text?: string
}) {
  const recipients = params.to
    .map((item) => String(item.email ?? '').trim())
    .filter(Boolean)

  if (!recipients.length) {
    return { ok: false as const, error: 'No recipients provided.' }
  }

  const { apiKey, from } = getConfig()
  if (!apiKey || !from) {
    if (isDev()) {
      const previewPath = await writeDevEmailPreview({
        to: recipients,
        subject: params.subject,
        html: params.html,
        text: params.text ?? '',
        reason: 'missing-email-config',
      })
      console.log('[email:dev-fallback]', {
        to: recipients,
        subject: params.subject,
        html: params.html,
        text: params.text ?? '',
        previewPath,
      })
      return { ok: true as const, fallback: true as const, previewPath }
    }

    return { ok: false as const, error: 'RESEND_API_KEY or EMAIL_FROM is not configured.' }
  }

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: recipients,
        subject: params.subject,
        html: params.html,
        text: params.text,
      }),
    })

    const json = (await response.json()) as { id?: string; message?: string; error?: string }

    if (!response.ok) {
      if (isDev()) {
        const previewPath = await writeDevEmailPreview({
          to: recipients,
          subject: params.subject,
          html: params.html,
          text: params.text ?? '',
          reason: `provider-error-${response.status}`,
        })
        console.log('[email:dev-fallback-on-error]', {
          status: response.status,
          to: recipients,
          subject: params.subject,
          response: json,
          previewPath,
        })
        return { ok: true as const, fallback: true as const, previewPath }
      }
      return { ok: false as const, error: json.message || json.error || `Email failed (${response.status}).` }
    }

    return { ok: true as const, id: json.id ?? '' }
  } catch (error) {
    if (isDev()) {
      const previewPath = await writeDevEmailPreview({
        to: recipients,
        subject: params.subject,
        html: params.html,
        text: params.text ?? '',
        reason: 'provider-exception',
      })
      console.log('[email:dev-fallback-on-exception]', {
        to: recipients,
        subject: params.subject,
        error: error instanceof Error ? error.message : 'unknown',
        previewPath,
      })
      return { ok: true as const, fallback: true as const, previewPath }
    }
    return { ok: false as const, error: error instanceof Error ? error.message : 'Email send failed.' }
  }
}
