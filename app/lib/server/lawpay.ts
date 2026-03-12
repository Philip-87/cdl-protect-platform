import { Buffer } from 'node:buffer'

export type LawPayMethodType = 'card' | 'bank'

export type LawPayChargeResult =
  | {
      ok: true
      providerChargeId: string
      providerStatus: string
      amountCents: number
      raw: unknown
    }
  | {
      ok: false
      error: string
      raw?: unknown
    }

function getLawPayConfig() {
  const secretKey = String(process.env.LAW_PAY_SECRET_KEY ?? '').trim()
  const cardAccountId = String(process.env.LAW_PAY_ClientCredit_OP ?? '').trim()
  const bankAccountId = String(process.env.LAW_PAY_eCheck_OP ?? '').trim()

  return {
    secretKey,
    cardAccountId,
    bankAccountId,
  }
}

export function getLawPayPublicAccountId() {
  return String(process.env.LAW_PAY_ACCOUNT_ID ?? '').trim()
}

function accountForMethod(methodType: LawPayMethodType, config: ReturnType<typeof getLawPayConfig>) {
  return methodType === 'bank' ? config.bankAccountId : config.cardAccountId
}

export async function createLawPayCharge(params: {
  amountCents: number
  methodTokenId: string
  methodType: LawPayMethodType
  idempotencyKey?: string
}): Promise<LawPayChargeResult> {
  const config = getLawPayConfig()
  if (!config.secretKey) {
    return { ok: false, error: 'LAW_PAY_SECRET_KEY is not configured.' }
  }

  const accountId = accountForMethod(params.methodType, config)
  if (!accountId) {
    return {
      ok: false,
      error:
        params.methodType === 'bank'
          ? 'LAW_PAY_eCheck_OP is not configured.'
          : 'LAW_PAY_ClientCredit_OP is not configured.',
    }
  }

  const amountCents = Math.round(params.amountCents)
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    return { ok: false, error: 'Amount must be greater than zero.' }
  }

  const methodToken = String(params.methodTokenId ?? '').trim()
  if (!methodToken) {
    return { ok: false, error: 'Missing LawPay payment token.' }
  }

  try {
    const basic = Buffer.from(`${config.secretKey}:`, 'utf8').toString('base64')
    const idempotencyKey = String(params.idempotencyKey ?? '').trim()
    const response = await fetch('https://api.8am.com/v1/charges', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${basic}`,
        'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      },
      body: JSON.stringify({
        amount: String(amountCents),
        method: methodToken,
        account_id: accountId,
      }),
    })

    const json = (await response.json()) as {
      id?: string
      status?: string
      amount?: number | string
      error?: string
      message?: string
    }

    if (!response.ok) {
      return {
        ok: false,
        error: json.error || json.message || `LawPay charge failed (${response.status}).`,
        raw: json,
      }
    }

    return {
      ok: true,
      providerChargeId: String(json.id ?? ''),
      providerStatus: String(json.status ?? 'unknown'),
      amountCents: Number(json.amount ?? amountCents),
      raw: json,
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'LawPay charge failed.',
    }
  }
}
