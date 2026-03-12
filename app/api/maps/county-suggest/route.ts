import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/supabase/server'
import { getMapsApiKey } from '@/app/lib/server/maps'

type GeocodeComponent = {
  long_name?: string
  short_name?: string
  types?: string[]
}

type GeocodeResult = {
  address_components?: GeocodeComponent[]
}

function componentOf(components: GeocodeComponent[], type: string, key: 'long_name' | 'short_name' = 'long_name') {
  const match = components.find((component) => component.types?.includes(type))
  return String(match?.[key] ?? '').trim()
}

function parseCounty(result: GeocodeResult) {
  const components = result.address_components ?? []
  const state = componentOf(components, 'administrative_area_level_1', 'short_name').toUpperCase()
  const countyRaw = componentOf(components, 'administrative_area_level_2')
  const county = countyRaw.replace(/\s+County$/i, '').trim()
  return { county, state }
}

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
    const state = String(searchParams.get('state') ?? '').trim().toUpperCase()

    if (input.length < 2) {
      return NextResponse.json({ ok: true, items: [] })
    }

    const query = `${input} County, ${state || 'US'}`
    const geocodeUrl = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    geocodeUrl.searchParams.set('address', query)
    geocodeUrl.searchParams.set('region', 'us')
    geocodeUrl.searchParams.set('key', apiKey)

    const response = await fetch(geocodeUrl.toString(), { cache: 'no-store' })
    const data = (await response.json()) as {
      status?: string
      error_message?: string
      results?: GeocodeResult[]
    }

    if (!response.ok || data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
      return NextResponse.json(
        { ok: false, error: data.error_message || data.status || 'County suggestion lookup failed.' },
        { status: 400 }
      )
    }

    const unique = new Set<string>()
    for (const result of data.results ?? []) {
      const parsed = parseCounty(result)
      if (!parsed.county) continue
      if (state && parsed.state !== state) continue
      unique.add(parsed.county)
      if (unique.size >= 8) break
    }

    return NextResponse.json({ ok: true, items: [...unique] })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'County suggestion request failed.',
      },
      { status: 500 }
    )
  }
}
