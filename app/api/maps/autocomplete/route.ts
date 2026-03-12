import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/supabase/server'
import { getMapsApiKey } from '@/app/lib/server/maps'

export async function GET(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 })
    }

    const apiKey = getMapsApiKey()
    if (!apiKey) {
      return NextResponse.json({ ok: false, error: 'GMAPS_API_KEY is not configured.' }, { status: 503 })
    }

    const { searchParams } = new URL(request.url)
    const input = String(searchParams.get('input') ?? '').trim()
    if (input.length < 3) {
      return NextResponse.json({ ok: true, items: [] })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json')
    url.searchParams.set('input', input)
    url.searchParams.set('types', 'address')
    url.searchParams.set('components', 'country:us')
    url.searchParams.set('key', apiKey)

    const response = await fetch(url.toString(), { cache: 'no-store' })
    const data = (await response.json()) as {
      status?: string
      error_message?: string
      predictions?: Array<{ description?: string; place_id?: string }>
    }

    if (!response.ok || data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
      return NextResponse.json(
        { ok: false, error: data.error_message || data.status || 'Autocomplete failed.' },
        { status: 400 }
      )
    }

    const items = (data.predictions ?? [])
      .filter((item) => item.description && item.place_id)
      .slice(0, 8)
      .map((item) => ({
        description: String(item.description),
        placeId: String(item.place_id),
      }))

    return NextResponse.json({ ok: true, items })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Autocomplete request failed.',
      },
      { status: 500 }
    )
  }
}
