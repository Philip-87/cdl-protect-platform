const MAPS_ENV_KEYS = [
  'GMAPS_API_KEY',
  'GOOGLE_MAPS_API_KEY',
  'NEXT_PUBLIC_GMAPS_API_KEY',
  'NEXT_PUBLIC_GOOGLE_MAPS_API_KEY',
] as const

export function getMapsApiKey() {
  for (const key of MAPS_ENV_KEYS) {
    const value = String(process.env[key] ?? '').trim()
    if (value) return value
  }
  return ''
}

export function isMapsApiKeyConfigured() {
  return getMapsApiKey().length > 0
}
