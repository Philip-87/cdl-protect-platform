import { NextResponse } from 'next/server'
import { previewAttorneyPricing } from '@/app/lib/matching/attorneyMatching'
import { createClient } from '@/app/lib/supabase/server'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const body = (await request.json()) as {
      state?: string
      county?: string
      cdlDriver?: boolean
    }
    const state = String(body.state ?? '').trim()
    const county = String(body.county ?? '').trim()
    const cdlDriver = body.cdlDriver === true

    const preview = await previewAttorneyPricing({
      state,
      county,
      isCdl: cdlDriver,
    })

    return NextResponse.json({
      ok: true,
      ...preview,
      message: preview.pricingAvailable
        ? 'Pricing is available for this court and county.'
        : 'Request a quote from our local attorneys',
    })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Pricing preview failed.',
      },
      { status: 500 }
    )
  }
}
