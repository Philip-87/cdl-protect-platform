function collapseWhitespace(value: string) {
  return value.replace(/\s+/g, ' ').trim()
}

export function normalizeCountyName(value: unknown) {
  const raw = collapseWhitespace(String(value ?? ''))
  if (!raw) return ''

  return raw
    .toUpperCase()
    .replace(/[.,]/g, ' ')
    .replace(/\bCITY AND BOROUGH\b/g, ' ')
    .replace(/\b(COUNTY|PARISH|BOROUGH|MUNICIPALITY|CENSUS AREA)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function countyNameAliases(value: unknown) {
  const raw = collapseWhitespace(String(value ?? '')).toUpperCase()
  const canonical = normalizeCountyName(value)
  const aliases = new Set<string>()

  if (raw) aliases.add(raw)
  if (canonical) aliases.add(canonical)

  if (canonical) {
    aliases.add(`${canonical} COUNTY`)
    aliases.add(`${canonical} PARISH`)
    aliases.add(`${canonical} BOROUGH`)
    aliases.add(`${canonical} MUNICIPALITY`)
    aliases.add(`${canonical} CENSUS AREA`)
    aliases.add(`${canonical} CITY AND BOROUGH`)
  }

  return Array.from(aliases).filter(Boolean)
}

export function countyNamesOverlap(left: unknown, right: unknown) {
  const leftAliases = new Set(countyNameAliases(left))
  return countyNameAliases(right).some((alias) => leftAliases.has(alias))
}
