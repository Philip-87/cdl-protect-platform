#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createClient } from '@supabase/supabase-js'

function usage() {
  console.log('Usage: node scripts/import-attorney-directory.mjs <path-to-csv>')
}

function parseCsvLine(line) {
  const result = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]

    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i += 1
      } else {
        inQuotes = !inQuotes
      }
      continue
    }

    if (char === ',' && !inQuotes) {
      result.push(current)
      current = ''
      continue
    }

    current += char
  }

  result.push(current)
  return result.map((item) => item.trim())
}

function parseCsv(content) {
  const lines = content.split(/\r?\n/).filter((line) => line.trim())
  if (!lines.length) return []

  const headers = parseCsvLine(lines[0]).map((header) => header.toLowerCase())
  return lines.slice(1).map((line) => {
    const cells = parseCsvLine(line)
    const row = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    return row
  })
}

function firstNonEmpty(row, keys) {
  for (const key of keys) {
    const value = String(row[key.toLowerCase()] ?? '').trim()
    if (value) return value
  }
  return ''
}

function parseLatLng(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return { lat: null, lng: null }
  const parts = text.split(',').map((item) => Number(item.trim()))
  if (parts.length !== 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) {
    return { lat: null, lng: null }
  }
  return { lat: parts[0], lng: parts[1] }
}

function parseCounties(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return []
  return text
    .split(/[;|,]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isStatewide(row, counties) {
  const direct = String(row['statewide'] ?? row['is_statewide'] ?? '').trim().toLowerCase()
  if (direct === 'yes' || direct === 'true' || direct === '1') return true
  return counties.some((item) => item.toUpperCase().includes('STATEWIDE'))
}

async function main() {
  const filePath = process.argv[2]
  if (!filePath) {
    usage()
    process.exit(1)
  }

  const fullPath = path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(fullPath)) {
    console.error(`CSV file not found: ${fullPath}`)
    process.exit(1)
  }

  const supabaseUrl = String(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '').trim()
  const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY ?? '').trim()

  if (!supabaseUrl || !serviceRoleKey) {
    console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment.')
    process.exit(1)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  })

  const content = fs.readFileSync(fullPath, 'utf8')
  const rows = parseCsv(content)
  if (!rows.length) {
    console.error('No rows found in CSV.')
    process.exit(1)
  }

  let imported = 0
  let skipped = 0

  for (const row of rows) {
    const name = firstNonEmpty(row, ['name', 'attorney', 'attorney_name', 'full_name'])
    const email = firstNonEmpty(row, ['email', 'attorney_email']).toLowerCase()
    const phone = firstNonEmpty(row, ['phone', 'mobile', 'attorney_phone'])
    const state = firstNonEmpty(row, ['state', 'st']).toUpperCase()
    const address = firstNonEmpty(row, ['address', 'office_address', 'street'])
    const countiesRaw = firstNonEmpty(row, ['counties', 'county', 'coverage_counties'])
    const counties = parseCounties(countiesRaw)

    const geocodeRaw = firstNonEmpty(row, ['geocode', 'latlng', 'lat_lng'])
    const latDirect = Number(firstNonEmpty(row, ['lat', 'latitude']))
    const lngDirect = Number(firstNonEmpty(row, ['lng', 'longitude']))
    const geocodePair = parseLatLng(geocodeRaw)
    const lat = Number.isFinite(latDirect) ? latDirect : geocodePair.lat
    const lng = Number.isFinite(lngDirect) ? lngDirect : geocodePair.lng

    if (!email || !state) {
      skipped += 1
      continue
    }

    const importSourceKey = firstNonEmpty(row, ['import_key', 'id'])
    const importKey =
      importSourceKey ||
      crypto.createHash('sha1').update(`${email}|${state}`).digest('hex')

    const payload = {
      import_key: importKey,
      name: name || email,
      email,
      phone: phone || null,
      state,
      address: address || null,
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null,
      is_statewide: isStatewide(row, counties),
      counties,
      metadata: {
        raw_row: row,
      },
      updated_at: new Date().toISOString(),
    }

    const upsert = await supabase.from('attorney_directory').upsert(payload, { onConflict: 'import_key' })
    if (upsert.error) {
      console.error(`Failed to import ${email} (${state}): ${upsert.error.message}`)
      skipped += 1
      continue
    }

    imported += 1
  }

  console.log(`Attorney directory import complete. Imported: ${imported}. Skipped: ${skipped}.`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
