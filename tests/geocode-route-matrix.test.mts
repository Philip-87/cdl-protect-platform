import test from 'node:test'
import assert from 'node:assert/strict'
import { computeDrivingDistanceMatrix, parseRouteMatrixResponse } from '../app/lib/server/geocode.ts'

test('parseRouteMatrixResponse parses newline-delimited route matrix elements', () => {
  const rows = parseRouteMatrixResponse(
    '{"destinationIndex":0,"distanceMeters":8046.72,"duration":"600s"}\n{"destinationIndex":1,"distanceMeters":16093.44,"duration":"1200s"}\n'
  )

  assert.equal(rows.length, 2)
  assert.equal(rows[0]?.destinationIndex, 0)
  assert.equal(rows[1]?.destinationIndex, 1)
})

test('computeDrivingDistanceMatrix maps route results back to the original destination indexes', async () => {
  const previousRoutesKey = process.env.GOOGLE_ROUTES_API_KEY
  const previousFetch = globalThis.fetch
  process.env.GOOGLE_ROUTES_API_KEY = 'routes-test-key'

  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    assert.match(String(input), /routes\.googleapis\.com\/distanceMatrix\/v2:computeRouteMatrix/)
    assert.equal(init?.method, 'POST')

    return new Response(
      '{"destinationIndex":0,"distanceMeters":8046.72,"duration":"600s"}\n{"destinationIndex":1,"distanceMeters":16093.44,"duration":"1200s"}\n',
      { status: 200 }
    )
  }) as typeof fetch

  try {
    const result = await computeDrivingDistanceMatrix({
      origin: { address: '123 Court St, Morgan County, WV' },
      destinations: [{ address: '10 Main St, Berkeley Springs, WV' }, { address: '20 High St, Hagerstown, MD' }],
    })

    assert.equal(result.ok, true)
    assert.equal(result.results.length, 2)
    assert.equal(result.results[0]?.ok, true)
    assert.ok(Math.abs(Number(result.results[0]?.miles) - 5) < 0.1)
    assert.equal(result.results[0]?.durationSeconds, 600)
    assert.ok(Math.abs(Number(result.results[1]?.miles) - 10) < 0.1)
  } finally {
    process.env.GOOGLE_ROUTES_API_KEY = previousRoutesKey
    globalThis.fetch = previousFetch
  }
})
