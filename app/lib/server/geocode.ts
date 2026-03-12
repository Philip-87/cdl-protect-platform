export type GeocodeResult = {
  ok: boolean
  lat: number | null
  lng: number | null
  formattedAddress: string
  error?: string
  raw?: unknown
}

export type RouteWaypointInput = {
  address?: string | null
  lat?: number | null
  lng?: number | null
}

export type RouteMatrixDistance = {
  destinationIndex: number
  ok: boolean
  miles: number | null
  durationSeconds: number | null
  error?: string
}

function getMapsApiKey() {
  return String(process.env.GOOGLE_MAPS_API_KEY ?? process.env.GMAPS_API_KEY ?? '').trim()
}

function getRoutesApiKey() {
  return String(process.env.GOOGLE_ROUTES_API_KEY ?? getMapsApiKey()).trim()
}

function toRouteWaypoint(input: RouteWaypointInput) {
  const lat = Number(input.lat)
  const lng = Number(input.lng)
  if (Number.isFinite(lat) && Number.isFinite(lng)) {
    return {
      location: {
        latLng: {
          latitude: lat,
          longitude: lng,
        },
      },
    }
  }

  const address = String(input.address ?? '').trim()
  if (address) {
    return { address }
  }

  return null
}

function parseDurationSeconds(value: unknown) {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^([0-9]+(?:\.[0-9]+)?)s$/i)
  if (!match) return null
  const seconds = Number(match[1])
  return Number.isFinite(seconds) ? seconds : null
}

export function parseRouteMatrixResponse(body: string) {
  return body
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

export async function geocodeAddress(address: string): Promise<GeocodeResult> {
  const apiKey = getMapsApiKey()
  if (!apiKey) {
    return {
      ok: false,
      lat: null,
      lng: null,
      formattedAddress: '',
      error: 'GOOGLE_MAPS_API_KEY is not configured.',
    }
  }

  const query = String(address ?? '').trim()
  if (!query) {
    return {
      ok: false,
      lat: null,
      lng: null,
      formattedAddress: '',
      error: 'Address is required for geocoding.',
    }
  }

  try {
    const url = new URL('https://maps.googleapis.com/maps/api/geocode/json')
    url.searchParams.set('address', query)
    url.searchParams.set('key', apiKey)

    const response = await fetch(url.toString(), { cache: 'no-store' })
    const json = (await response.json()) as {
      status?: string
      error_message?: string
      results?: Array<{
        formatted_address?: string
        geometry?: { location?: { lat?: number; lng?: number } }
      }>
    }

    if (!response.ok || json.status === 'REQUEST_DENIED' || json.status === 'INVALID_REQUEST') {
      return {
        ok: false,
        lat: null,
        lng: null,
        formattedAddress: '',
        error: json.error_message || json.status || `Geocoding failed (${response.status}).`,
        raw: json,
      }
    }

    const first = json.results?.[0]
    const lat = Number(first?.geometry?.location?.lat)
    const lng = Number(first?.geometry?.location?.lng)

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      return {
        ok: false,
        lat: null,
        lng: null,
        formattedAddress: String(first?.formatted_address ?? ''),
        error: 'Geocoding returned no coordinates.',
        raw: json,
      }
    }

    return {
      ok: true,
      lat,
      lng,
      formattedAddress: String(first?.formatted_address ?? '').trim(),
      raw: json,
    }
  } catch (error) {
    return {
      ok: false,
      lat: null,
      lng: null,
      formattedAddress: '',
      error: error instanceof Error ? error.message : 'Geocoding failed.',
    }
  }
}

export async function computeDrivingDistanceMatrix(params: {
  origin: RouteWaypointInput
  destinations: RouteWaypointInput[]
}): Promise<{
  ok: boolean
  results: RouteMatrixDistance[]
  error?: string
  raw?: unknown
}> {
  const apiKey = getRoutesApiKey()
  if (!apiKey) {
    return {
      ok: false,
      results: [],
      error: 'Google Routes API key is not configured.',
    }
  }

  const origin = toRouteWaypoint(params.origin)
  if (!origin) {
    return {
      ok: false,
      results: [],
      error: 'A court address or coordinate is required for route matching.',
    }
  }

  const destinationWaypoints = params.destinations.map((destination, destinationIndex) => ({
    destinationIndex,
    waypoint: toRouteWaypoint(destination),
  }))
  const validDestinations = destinationWaypoints.filter(
    (destination): destination is { destinationIndex: number; waypoint: NonNullable<ReturnType<typeof toRouteWaypoint>> } =>
      Boolean(destination.waypoint)
  )

  if (!validDestinations.length) {
    return {
      ok: false,
      results: destinationWaypoints.map((destination) => ({
        destinationIndex: destination.destinationIndex,
        ok: false,
        miles: null,
        durationSeconds: null,
        error: 'Attorney address is missing.',
      })),
      error: 'No attorney destinations included a routable address.',
    }
  }

  try {
    const response = await fetch('https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix', {
      method: 'POST',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'originIndex,destinationIndex,status,condition,distanceMeters,duration',
      },
      body: JSON.stringify({
        origins: [{ waypoint: origin }],
        destinations: validDestinations.map((destination) => ({ waypoint: destination.waypoint })),
        travelMode: 'DRIVE',
        routingPreference: 'TRAFFIC_UNAWARE',
      }),
    })

    const body = await response.text()
    const defaultResults: RouteMatrixDistance[] = destinationWaypoints.map((destination) => ({
      destinationIndex: destination.destinationIndex,
      ok: false,
      miles: null,
      durationSeconds: null,
      error: destination.waypoint ? 'No route was returned.' : 'Attorney address is missing.',
    }))

    if (!response.ok) {
      let message = `Route matrix failed (${response.status}).`
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } }
        if (parsed.error?.message) message = parsed.error.message
      } catch {}

      return {
        ok: false,
        results: defaultResults,
        error: message,
        raw: body,
      }
    }

    const rows = parseRouteMatrixResponse(body)
    const results: RouteMatrixDistance[] = [...defaultResults]

    for (const row of rows) {
      const matrixIndex = Number(row.destinationIndex)
      const mappedDestination = validDestinations[matrixIndex]
      if (!Number.isInteger(matrixIndex) || !mappedDestination) continue

      const distanceMeters = Number(row.distanceMeters)
      const durationSeconds = parseDurationSeconds(row.duration)
      const status = row.status as { message?: string } | undefined
      const condition = String(row.condition ?? '')

      if (Number.isFinite(distanceMeters) && distanceMeters >= 0) {
        results[mappedDestination.destinationIndex] = {
          destinationIndex: mappedDestination.destinationIndex,
          ok: true,
          miles: distanceMeters / 1609.344,
          durationSeconds,
        }
        continue
      }

      results[mappedDestination.destinationIndex] = {
        destinationIndex: mappedDestination.destinationIndex,
        ok: false,
        miles: null,
        durationSeconds,
        error: status?.message || condition || 'No route was returned.',
      }
    }

    return {
      ok: results.some((result) => result.ok),
      results,
      raw: rows,
    }
  } catch (error) {
    return {
      ok: false,
      results: destinationWaypoints.map((destination) => ({
        destinationIndex: destination.destinationIndex,
        ok: false,
        miles: null,
        durationSeconds: null,
        error: destination.waypoint ? 'Route lookup failed.' : 'Attorney address is missing.',
      })),
      error: error instanceof Error ? error.message : 'Route lookup failed.',
    }
  }
}

export function milesBetween(params: {
  lat1: number
  lng1: number
  lat2: number
  lng2: number
}) {
  const { lat1, lng1, lat2, lng2 } = params
  const toRadians = (value: number) => (value * Math.PI) / 180
  const earthMiles = 3958.8

  const dLat = toRadians(lat2 - lat1)
  const dLng = toRadians(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return earthMiles * c
}
