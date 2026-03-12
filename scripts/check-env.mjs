import fs from 'node:fs'
import path from 'node:path'

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
  const entries = new Map()

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const separatorIndex = line.indexOf('=')
    if (separatorIndex < 1) continue

    const key = line.slice(0, separatorIndex).trim()
    const value = line.slice(separatorIndex + 1).trim()
    entries.set(key, value)
  }

  return entries
}

function isDevelopmentDefault(key, value, exampleValue) {
  if (!value) return false

  if (value === exampleValue && /replace|your_|example\.com/i.test(exampleValue)) {
    return true
  }

  if (/replace|change-me|your_|example\.com|localhost\.test/i.test(value)) {
    return true
  }

  if (/^http:\/\/localhost(?::\d+)?/i.test(value)) {
    return true
  }

  if (/^local-/i.test(value) && /SECRET|WORKER_ID/.test(key)) {
    return true
  }

  return false
}

function printSection(title, keys) {
  if (!keys.length) return
  console.log(`\n${title}:`)
  for (const key of keys) {
    console.log(`- ${key}`)
  }
}

const cwd = process.cwd()
const examplePath = path.join(cwd, '.env.example')
const localPath = path.join(cwd, '.env.local')

if (!fs.existsSync(examplePath)) {
  console.error('Missing .env.example')
  process.exit(1)
}

if (!fs.existsSync(localPath)) {
  console.error('Missing .env.local')
  process.exit(1)
}

const example = parseEnvFile(examplePath)
const local = parseEnvFile(localPath)

const missing = []
const blank = []
const developmentDefaults = []

for (const [key, exampleValue] of example.entries()) {
  if (!local.has(key)) {
    missing.push(key)
    continue
  }

  const value = String(local.get(key) ?? '')
  if (!value) {
    blank.push(key)
    continue
  }

  if (isDevelopmentDefault(key, value, exampleValue)) {
    developmentDefaults.push(key)
  }
}

const extra = [...local.keys()].filter((key) => !example.has(key)).sort()

console.log('Environment audit complete.')
console.log(`Expected keys: ${example.size}`)
console.log(`Configured keys: ${local.size}`)
console.log(`Missing keys: ${missing.length}`)
console.log(`Blank keys: ${blank.length}`)
console.log(`Development defaults/placeholders: ${developmentDefaults.length}`)
console.log(`Extra keys not in template: ${extra.length}`)

printSection('Missing keys', missing)
printSection('Blank keys', blank)
printSection('Development defaults or placeholders', developmentDefaults)
printSection('Extra keys', extra)

if (!missing.length && !blank.length && !developmentDefaults.length) {
  console.log('\nEnvironment looks complete.')
} else {
  console.log('\nEnvironment has items that still need staging or production setup.')
}
