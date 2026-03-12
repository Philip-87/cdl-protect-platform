import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/supabase/server'
import { getMapsApiKey } from '@/app/lib/server/maps'

type AddressComponent = {
  long_name?: string
  short_name?: string
  types?: string[]
}

function getComponent(
  components: AddressComponent[],
  type: string,
  kind: 'long_name' | 'short_name' = 'long_name'
) {
  const found = components.find((component) => component.types?.includes(type))
  if (!found) return ''
  return String(found[kind] ?? '').trim()
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
    const placeId = String(searchParams.get('placeId') ?? '').trim()
    if (!placeId) {
      return NextResponse.json({ ok: false, error: 'placeId is required.' }, { status: 400 })
    }

    const url = new URL('https://maps.googleapis.com/maps/api/place/details/json')
    url.searchParams.set('place_id', placeId)
    url.searchParams.set('fields', 'formatted_address,address_component')
    url.searchParams.set('key', apiKey)

    const response = await fetch(url.toString(), { cache: 'no-store' })
    const data = (await response.json()) as {
      status?: string
      error_message?: string
      result?: {
        formatted_address?: string
        address_components?: AddressComponent[]
      }
    }

    if (!response.ok || data.status === 'REQUEST_DENIED' || data.status === 'INVALID_REQUEST') {
      return NextResponse.json(
        { ok: false, error: data.error_message || data.status || 'Place details failed.' },
        { status: 400 }
      )
    }

    const components = data.result?.address_components ?? []
    const city =
      getComponent(components, 'locality') ||
      getComponent(components, 'postal_town') ||
      getComponent(components, 'sublocality')
    const stateCode = getComponent(components, 'administrative_area_level_1', 'short_name').toUpperCase()
    const rawCounty = getComponent(components, 'administrative_area_level_2')
    const county = rawCounty.replace(/\s+County$/i, '').trim()
    const zipCode = getComponent(components, 'postal_code')

    return NextResponse.json({
      ok: true,
      details: {
        formattedAddress: String(data.result?.formatted_address ?? ''),
        city,
        stateCode,
        county,
        zipCode,
      },
    })
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Place details request failed.',
      },
      { status: 500 }
    )
  }
}
