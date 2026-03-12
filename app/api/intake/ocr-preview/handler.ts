import { validateTicketUpload } from '../../../lib/server/ticket-upload.ts'

type OcrPreviewResult = {
  ok: boolean
  confidence: number
  fields: Record<string, unknown>
  raw: unknown
  error?: string
}

type OcrRunner = (file: File) => Promise<OcrPreviewResult>

export type OcrPreviewResponse = {
  status: number
  body:
    | { ok: true; confidence: number; fields: Record<string, unknown> }
    | { ok: false; error: string; raw?: unknown }
}

export async function handleOcrPreviewRequest(params: {
  userId: string | null
  formData: FormData
  runOcrFromFile: OcrRunner
}): Promise<OcrPreviewResponse> {
  if (!params.userId) {
    return {
      status: 401,
      body: { ok: false, error: 'Unauthorized' },
    }
  }

  const fileEntry = params.formData.get('file')
  if (!(fileEntry instanceof File) || fileEntry.size === 0) {
    return {
      status: 400,
      body: { ok: false, error: 'File is required.' },
    }
  }

  const uploadError = validateTicketUpload(fileEntry, 'File')
  if (uploadError) {
    return {
      status: 400,
      body: { ok: false, error: uploadError },
    }
  }

  const ocr = await params.runOcrFromFile(fileEntry)
  if (!ocr.ok) {
    return {
      status: 200,
      body: {
        ok: false,
        error: ocr.error || 'OCR failed.',
        raw: ocr.raw,
      },
    }
  }

  return {
    status: 200,
    body: {
      ok: true,
      confidence: ocr.confidence,
      fields: ocr.fields,
    },
  }
}
