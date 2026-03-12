import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/supabase/server'
import { hashBrowserFile, issueOcrPreviewToken } from '@/app/lib/server/ocr-preview-token'
import { runTicketOcrFromFile } from '@/app/lib/server/ocr'
import { handleOcrPreviewRequest } from './handler'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const formData = await request.formData()
    const result = await handleOcrPreviewRequest({
      userId: user?.id ?? null,
      formData,
      runOcrFromFile: runTicketOcrFromFile,
    })

    if (result.status === 200 && result.body.ok && user?.id) {
      const fileEntry = formData.get('file')
      if (fileEntry instanceof File && fileEntry.size > 0) {
        const fileHash = await hashBrowserFile(fileEntry)
        const previewToken = issueOcrPreviewToken({
          userId: user.id,
          fileHash,
          confidence: result.body.confidence,
          fields: result.body.fields,
        })

        return NextResponse.json(
          {
            ...result.body,
            fileHash,
            previewToken,
          },
          { status: result.status }
        )
      }
    }

    return NextResponse.json(result.body, { status: result.status })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'OCR preview failed.',
      },
      { status: 500 }
    )
  }
}
