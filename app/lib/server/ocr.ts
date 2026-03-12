const WAIT_MS = 2500
const MAX_POLLS = 24

type PickValue = { text: string; score: number }

type OcrMappedFields = {
  firstName: string
  lastName: string
  brokersEmailTmp: string
  state: string
  ticket: string
  violationTypes: string
  dateOfViolation: string
  court_id: string
  courtDate: string
  courtTime: string
  courtAddress: string
  courtCounty: string
  violationType: string
}

type OcrOutcome = {
  ok: boolean
  confidence: number
  fields: OcrMappedFields
  raw: unknown
  error?: string
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : ''
}

const EMPTY_FIELDS: OcrMappedFields = {
  firstName: '',
  lastName: '',
  brokersEmailTmp: '',
  state: '',
  ticket: '',
  violationTypes: '',
  dateOfViolation: '',
  court_id: '',
  courtDate: '',
  courtTime: '',
  courtAddress: '',
  courtCounty: '',
  violationType: '',
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function normalizeTimeString(raw: string) {
  if (!raw) return ''
  const s = String(raw).trim()

  if (/^\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?$/.test(s)) return s.slice(0, 5)

  const hm = /^(\d{1,2}):(\d{2})$/
  if (hm.test(s)) {
    const [, h, mi] = s.match(hm) ?? []
    return `${String(h).padStart(2, '0')}:${mi}`
  }

  const ampm = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/
  if (ampm.test(s)) {
    const [, hh, mm = '00', ap] = s.match(ampm) ?? []
    let H = Number(hh)
    if (ap.toUpperCase() === 'PM' && H < 12) H += 12
    if (ap.toUpperCase() === 'AM' && H === 12) H = 0
    return `${String(H).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
  }

  return s
}

export function buildTicketOcrText(fields: Record<string, unknown>) {
  const lines = [
    ['Citation', fields['ticket']],
    ['Violation', fields['violationType'] || fields['violationTypes']],
    ['Violation Date', fields['dateOfViolation']],
    ['Court', fields['court_id']],
    ['Court Date', fields['courtDate']],
    ['Court Time', fields['courtTime']],
    ['Court Address', fields['courtAddress']],
    ['County', fields['courtCounty']],
    ['State', fields['state']],
  ]
    .map(([label, value]) => [label, textValue(value)] as const)
    .filter(([, value]) => value)

  return lines.map(([label, value]) => `${label}: ${value}`).join('\n')
}

function normalizeStateAbbrev(value: string) {
  const map: Record<string, string> = {
    AL: 'AL',
    ALASKA: 'AK',
    AK: 'AK',
    ARIZONA: 'AZ',
    AZ: 'AZ',
    ARKANSAS: 'AR',
    AR: 'AR',
    CALIFORNIA: 'CA',
    CA: 'CA',
    COLORADO: 'CO',
    CO: 'CO',
    CONNECTICUT: 'CT',
    CT: 'CT',
    DELAWARE: 'DE',
    DE: 'DE',
    FLORIDA: 'FL',
    FL: 'FL',
    GEORGIA: 'GA',
    GA: 'GA',
    HAWAII: 'HI',
    HI: 'HI',
    IDAHO: 'ID',
    ID: 'ID',
    ILLINOIS: 'IL',
    IL: 'IL',
    INDIANA: 'IN',
    IN: 'IN',
    IOWA: 'IA',
    IA: 'IA',
    KANSAS: 'KS',
    KS: 'KS',
    KENTUCKY: 'KY',
    KY: 'KY',
    LOUISIANA: 'LA',
    LA: 'LA',
    MAINE: 'ME',
    ME: 'ME',
    MARYLAND: 'MD',
    MD: 'MD',
    MASSACHUSETTS: 'MA',
    MA: 'MA',
    MICHIGAN: 'MI',
    MI: 'MI',
    MINNESOTA: 'MN',
    MN: 'MN',
    MISSISSIPPI: 'MS',
    MS: 'MS',
    MISSOURI: 'MO',
    MO: 'MO',
    MONTANA: 'MT',
    MT: 'MT',
    NEBRASKA: 'NE',
    NE: 'NE',
    NEVADA: 'NV',
    NV: 'NV',
    'NEW HAMPSHIRE': 'NH',
    NH: 'NH',
    'NEW JERSEY': 'NJ',
    NJ: 'NJ',
    'NEW MEXICO': 'NM',
    NM: 'NM',
    'NEW YORK': 'NY',
    NY: 'NY',
    'NORTH CAROLINA': 'NC',
    NC: 'NC',
    'NORTH DAKOTA': 'ND',
    ND: 'ND',
    OHIO: 'OH',
    OH: 'OH',
    OKLAHOMA: 'OK',
    OK: 'OK',
    OREGON: 'OR',
    OR: 'OR',
    PENNSYLVANIA: 'PA',
    PA: 'PA',
    'RHODE ISLAND': 'RI',
    RI: 'RI',
    'SOUTH CAROLINA': 'SC',
    SC: 'SC',
    'SOUTH DAKOTA': 'SD',
    SD: 'SD',
    TENNESSEE: 'TN',
    TN: 'TN',
    TEXAS: 'TX',
    TX: 'TX',
    UTAH: 'UT',
    UT: 'UT',
    VERMONT: 'VT',
    VT: 'VT',
    VIRGINIA: 'VA',
    VA: 'VA',
    WASHINGTON: 'WA',
    WA: 'WA',
    'WEST VIRGINIA': 'WV',
    WV: 'WV',
    WISCONSIN: 'WI',
    WI: 'WI',
    WYOMING: 'WY',
    WY: 'WY',
    'DISTRICT OF COLUMBIA': 'DC',
    DC: 'DC',
  }

  const key = String(value || '').trim().toUpperCase()
  if (!key) return ''
  return map[key] || key.slice(0, 2)
}

function normLabel(value: string) {
  return String(value || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '')
}

function predsOf(json: unknown): Array<Record<string, unknown>> {
  const obj = json as Record<string, unknown>
  const result = Array.isArray(obj?.result) ? (obj.result[0] as Record<string, unknown>) : undefined

  if (result && Array.isArray(result.prediction)) return result.prediction as Array<Record<string, unknown>>
  if (result && Array.isArray(result.predicted_boxes)) {
    return result.predicted_boxes as Array<Record<string, unknown>>
  }
  if (Array.isArray(obj?.prediction)) return obj.prediction as Array<Record<string, unknown>>
  if (Array.isArray(obj?.predicted_boxes)) return obj.predicted_boxes as Array<Record<string, unknown>>

  return []
}

function findPred(preds: Array<Record<string, unknown>>, labels: string[]) {
  const wanted = labels.map(normLabel)
  let best: Record<string, unknown> | null = null

  for (const pred of preds) {
    const label = normLabel(String(pred.label || pred.field || pred.name || pred.key || ''))
    if (!label || !wanted.includes(label)) continue

    const score = Number(pred.score || 0)
    if (!best || score > Number(best.score || 0)) best = pred
  }

  return best
}

function pick(preds: Array<Record<string, unknown>>, labels: string[]): PickValue {
  const pred = findPred(preds, labels)
  const text = String(pred?.ocr_text || pred?.text || '').trim()
  const score = Number(pred?.score || 0)
  return { text, score }
}

function avgScore(preds: Array<Record<string, unknown>>) {
  const values = preds.map((p) => Number(p.score)).filter(Number.isFinite)
  if (!values.length) return 0.4
  return values.reduce((a, b) => a + b, 0) / values.length
}

function mapFields(json: unknown): { fields: OcrMappedFields; confidence: number } {
  const preds = predsOf(json)
  const confidence = avgScore(preds)

  const first = pick(preds, ['Defendant_First_Name'])
  const last = pick(preds, ['Defendant_Last_Name'])
  const senderEmail = pick(preds, ['Sender_Email'])
  const state = pick(preds, ['State_of_Offence', 'State_of_Offense', 'State'])
  const ticket = pick(preds, ['Document_ID', 'Citation_Number', 'Ticket_Number'])
  const violationTypes = pick(preds, ['Nature_of_Offense', 'Nature_of_Offence'])
  const violationDate = pick(preds, ['Violation_Date'])
  const court = pick(preds, ['Court_Name'])
  const courtDate = pick(preds, ['Court_Date'])
  const courtTime = pick(preds, ['Court_Time'])
  const courtAddress = pick(preds, ['Court_Address'])
  const county = pick(preds, ['County'])
  const code = pick(preds, ['Offense_Code', 'Violation_Code'])

  const strict = 0.5
  const relaxed = 0.3

  return {
    confidence,
    fields: {
      firstName: first.score >= strict ? first.text : '',
      lastName: last.score >= strict ? last.text : '',
      brokersEmailTmp: senderEmail.score >= strict ? senderEmail.text : '',
      state: state.score >= relaxed ? normalizeStateAbbrev(state.text) : '',
      ticket: ticket.score >= strict ? ticket.text : '',
      violationTypes: violationTypes.score >= relaxed ? violationTypes.text : '',
      dateOfViolation: violationDate.score >= relaxed ? violationDate.text : '',
      court_id: court.score >= relaxed ? court.text : '',
      courtDate: courtDate.score >= relaxed ? courtDate.text : '',
      courtTime: courtTime.score >= relaxed ? normalizeTimeString(courtTime.text) : '',
      courtAddress: courtAddress.score >= relaxed ? courtAddress.text : '',
      courtCounty: county.score >= relaxed ? county.text : '',
      violationType: code.score >= relaxed ? code.text : '',
    },
  }
}

function basicAuthHeader(apiKey: string) {
  return `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`
}

function parseResponseBody(response: Response) {
  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) return response.json()
  return response.text()
}

function uniqueNonEmpty(values: string[]) {
  const set = new Set<string>()
  values.forEach((value) => {
    const cleaned = String(value || '').trim()
    if (cleaned) set.add(cleaned)
  })
  return [...set]
}

function buildStartUrls(modelId: string) {
  const configured = String(process.env.NANONETS_START_URL || '').trim()
  if (configured) return [configured]

  return uniqueNonEmpty([
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelUrls`,
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelUrls/`,
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelUrls/?async=true`,
  ])
}

function buildFileStartUrls(modelId: string) {
  const configured = String(process.env.NANONETS_FILE_START_URL || '').trim()
  if (configured) return [configured]

  return uniqueNonEmpty([
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelFile`,
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelFile/`,
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/LabelFile/?async=true`,
  ])
}

function buildPollUrls(modelId: string, requestId: string) {
  const configuredTemplate = String(process.env.NANONETS_RESULT_URL_TEMPLATE || '').trim()
  const configured = configuredTemplate
    ? configuredTemplate.replace('{modelId}', modelId).replace('{requestId}', requestId)
    : ''

  return uniqueNonEmpty([
    configured,
    `https://app.nanonets.com/api/v2/OCR/Model/${modelId}/Result/${requestId}/`,
    `https://app.nanonets.com/api/v2/Inferences/Model/${modelId}/InferenceRequestFiles/GetPredictions/${requestId}`,
    `https://app.nanonets.com/api/v2/Inferences/Model/${modelId}/ImageLevelInferences/${requestId}`,
  ])
}

function buildStartBodies(
  publicUrl: string
): Array<{ body: BodyInit; headers: Record<string, string>; label: string }> {
  const asFormEncoded = new URLSearchParams()
  asFormEncoded.append('urls', publicUrl)
  asFormEncoded.append('url', publicUrl)

  const asMultipart = new FormData()
  asMultipart.append('urls', publicUrl)
  asMultipart.append('url', publicUrl)

  return [
    {
      body: asFormEncoded,
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      label: 'urlencoded',
    },
    {
      body: asMultipart,
      headers: {},
      label: 'multipart',
    },
  ]
}

function buildFileStartBodies(
  file: File
): Array<{ body: BodyInit; headers: Record<string, string>; label: string }> {
  const bodyFile = new FormData()
  bodyFile.append('file', file, file.name || 'document')

  const bodyDocument = new FormData()
  bodyDocument.append('document', file, file.name || 'document')

  const bodyFiles = new FormData()
  bodyFiles.append('files', file, file.name || 'document')

  return [
    { body: bodyFile, headers: {}, label: 'multipart:file' },
    { body: bodyDocument, headers: {}, label: 'multipart:document' },
    { body: bodyFiles, headers: {}, label: 'multipart:files' },
  ]
}

function extractRequestIds(payload: unknown) {
  const obj = payload as Record<string, unknown>
  const ids = new Set<string>()

  const direct = [obj.request_id, obj.request_file_id, obj.id]
  for (const v of direct) {
    if (typeof v === 'string' && v) ids.add(v)
  }

  if (Array.isArray(obj.request_ids)) {
    obj.request_ids.forEach((v) => {
      if (typeof v === 'string' && v) ids.add(v)
    })
  }

  if (Array.isArray(obj.result)) {
    obj.result.forEach((entry) => {
      const rec = entry as Record<string, unknown>
      const values = [rec.request_id, rec.request_file_id, rec.id]
      values.forEach((v) => {
        if (typeof v === 'string' && v) ids.add(v)
      })
    })
  }

  return [...ids]
}

function hasPredictionPayload(payload: unknown) {
  return predsOf(payload).length > 0
}

export async function runTicketOcrFromPublicUrl(publicUrl: string): Promise<OcrOutcome> {
  const apiKey = process.env.NANONETS_API_KEY
  const modelId = process.env.NANONETS_MODEL_ID

  if (!apiKey || !modelId) {
    return {
      ok: false,
      confidence: 0,
      fields: EMPTY_FIELDS,
      raw: null,
      error: 'OCR not configured. Set NANONETS_API_KEY and NANONETS_MODEL_ID.',
    }
  }

  const auth = basicAuthHeader(apiKey)
  const startUrls = buildStartUrls(modelId)
  let startPayload: unknown = null
  let startError = ''
  let requestIds: string[] = []

  startLoop: for (const startUrl of startUrls) {
    for (const attempt of buildStartBodies(publicUrl)) {
      try {
        const startResp = await fetch(startUrl, {
          method: 'POST',
          headers: new Headers({
            Authorization: auth,
            Accept: 'application/json',
            ...attempt.headers,
          }),
          body: attempt.body,
        })

        startPayload = await parseResponseBody(startResp)

        if (!startResp.ok) {
          startError = `OCR start failed (${startResp.status}) via ${attempt.label} at ${startUrl}.`
          continue
        }

        if (hasPredictionPayload(startPayload)) {
          const mapped = mapFields(startPayload)
          return {
            ok: true,
            confidence: mapped.confidence,
            fields: mapped.fields,
            raw: startPayload,
          }
        }

        requestIds = extractRequestIds(startPayload)
        if (requestIds.length) break startLoop
        startError = `OCR start response did not include request id via ${attempt.label} at ${startUrl}.`
      } catch (error) {
        startError = error instanceof Error ? error.message : 'OCR start request failed.'
      }
    }
  }

  if (!requestIds.length) {
    return {
      ok: false,
      confidence: 0,
      fields: EMPTY_FIELDS,
      raw: startPayload,
      error: startError || 'OCR response did not include a request id.',
    }
  }

  for (let i = 0; i < MAX_POLLS; i += 1) {
    for (const requestId of requestIds) {
      const pollUrls = buildPollUrls(modelId, requestId)

      for (const pollUrl of pollUrls) {
        try {
          const pollResp = await fetch(pollUrl, {
            method: 'GET',
            headers: {
              Authorization: auth,
              Accept: 'application/json',
            },
          })

          if (!pollResp.ok) continue

          const pollPayload = await parseResponseBody(pollResp)
          if (!hasPredictionPayload(pollPayload)) continue

          const mapped = mapFields(pollPayload)
          return {
            ok: true,
            confidence: mapped.confidence,
            fields: mapped.fields,
            raw: pollPayload,
          }
        } catch {
          // continue polling
        }
      }
    }

    await sleep(WAIT_MS)
  }

  return {
    ok: false,
    confidence: 0,
    fields: EMPTY_FIELDS,
    raw: { startPayload, requestIds },
    error: startError || 'OCR timed out while waiting for result.',
  }
}

export async function runTicketOcrFromFile(file: File): Promise<OcrOutcome> {
  const apiKey = process.env.NANONETS_API_KEY
  const modelId = process.env.NANONETS_MODEL_ID

  if (!apiKey || !modelId) {
    return {
      ok: false,
      confidence: 0,
      fields: EMPTY_FIELDS,
      raw: null,
      error: 'OCR not configured. Set NANONETS_API_KEY and NANONETS_MODEL_ID.',
    }
  }

  const auth = basicAuthHeader(apiKey)
  const startUrls = buildFileStartUrls(modelId)
  let startPayload: unknown = null
  let startError = ''
  let requestIds: string[] = []

  startLoop: for (const startUrl of startUrls) {
    for (const attempt of buildFileStartBodies(file)) {
      try {
        const startResp = await fetch(startUrl, {
          method: 'POST',
          headers: new Headers({
            Authorization: auth,
            Accept: 'application/json',
            ...attempt.headers,
          }),
          body: attempt.body,
        })

        startPayload = await parseResponseBody(startResp)

        if (!startResp.ok) {
          startError = `OCR file start failed (${startResp.status}) via ${attempt.label} at ${startUrl}.`
          continue
        }

        if (hasPredictionPayload(startPayload)) {
          const mapped = mapFields(startPayload)
          return {
            ok: true,
            confidence: mapped.confidence,
            fields: mapped.fields,
            raw: startPayload,
          }
        }

        requestIds = extractRequestIds(startPayload)
        if (requestIds.length) break startLoop
        startError = `OCR file response did not include request id via ${attempt.label} at ${startUrl}.`
      } catch (error) {
        startError = error instanceof Error ? error.message : 'OCR file request failed.'
      }
    }
  }

  if (!requestIds.length) {
    return {
      ok: false,
      confidence: 0,
      fields: EMPTY_FIELDS,
      raw: startPayload,
      error: startError || 'OCR response did not include a request id.',
    }
  }

  for (let i = 0; i < MAX_POLLS; i += 1) {
    for (const requestId of requestIds) {
      const pollUrls = buildPollUrls(modelId, requestId)

      for (const pollUrl of pollUrls) {
        try {
          const pollResp = await fetch(pollUrl, {
            method: 'GET',
            headers: {
              Authorization: auth,
              Accept: 'application/json',
            },
          })

          if (!pollResp.ok) continue

          const pollPayload = await parseResponseBody(pollResp)
          if (!hasPredictionPayload(pollPayload)) continue

          const mapped = mapFields(pollPayload)
          return {
            ok: true,
            confidence: mapped.confidence,
            fields: mapped.fields,
            raw: pollPayload,
          }
        } catch {
          // continue polling
        }
      }
    }

    await sleep(WAIT_MS)
  }

  return {
    ok: false,
    confidence: 0,
    fields: EMPTY_FIELDS,
    raw: { startPayload, requestIds },
    error: startError || 'OCR timed out while waiting for result.',
  }
}
