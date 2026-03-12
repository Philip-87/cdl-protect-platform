'use client'

import { useEffect, useMemo, useState } from 'react'
import { saveAttorneyFirmProfile } from './actions'
import styles from './my-firm.module.css'

type FirmInitial = {
  fullName: string
  email: string
  phone: string
  state: string
  officeAddress: string
  city: string
  zipCode: string
  coverageStates: string[]
  counties: string[]
  primaryCounty: string
}

type AddressSuggestion = {
  description: string
  placeId: string
}

const STATES: Array<[string, string]> = [
  ['AL', 'Alabama'],
  ['AK', 'Alaska'],
  ['AZ', 'Arizona'],
  ['AR', 'Arkansas'],
  ['CA', 'California'],
  ['CO', 'Colorado'],
  ['CT', 'Connecticut'],
  ['DE', 'Delaware'],
  ['DC', 'District of Columbia'],
  ['FL', 'Florida'],
  ['GA', 'Georgia'],
  ['HI', 'Hawaii'],
  ['ID', 'Idaho'],
  ['IL', 'Illinois'],
  ['IN', 'Indiana'],
  ['IA', 'Iowa'],
  ['KS', 'Kansas'],
  ['KY', 'Kentucky'],
  ['LA', 'Louisiana'],
  ['ME', 'Maine'],
  ['MD', 'Maryland'],
  ['MA', 'Massachusetts'],
  ['MI', 'Michigan'],
  ['MN', 'Minnesota'],
  ['MS', 'Mississippi'],
  ['MO', 'Missouri'],
  ['MT', 'Montana'],
  ['NE', 'Nebraska'],
  ['NV', 'Nevada'],
  ['NH', 'New Hampshire'],
  ['NJ', 'New Jersey'],
  ['NM', 'New Mexico'],
  ['NY', 'New York'],
  ['NC', 'North Carolina'],
  ['ND', 'North Dakota'],
  ['OH', 'Ohio'],
  ['OK', 'Oklahoma'],
  ['OR', 'Oregon'],
  ['PA', 'Pennsylvania'],
  ['RI', 'Rhode Island'],
  ['SC', 'South Carolina'],
  ['SD', 'South Dakota'],
  ['TN', 'Tennessee'],
  ['TX', 'Texas'],
  ['UT', 'Utah'],
  ['VT', 'Vermont'],
  ['VA', 'Virginia'],
  ['WA', 'Washington'],
  ['WV', 'West Virginia'],
  ['WI', 'Wisconsin'],
  ['WY', 'Wyoming'],
]

export default function MyFirmEditor({
  initial,
  message,
  countiesByState,
  mapsEnabled,
}: {
  initial: FirmInitial
  message?: string
  countiesByState: Record<string, string[]>
  mapsEnabled: boolean
}) {
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [fullName, setFullName] = useState(initial.fullName)
  const [email, setEmail] = useState(initial.email)
  const [phone, setPhone] = useState(initial.phone)
  const [stateCode, setStateCode] = useState(initial.state)
  const [officeAddress, setOfficeAddress] = useState(initial.officeAddress)
  const [city, setCity] = useState(initial.city)
  const [zipCode, setZipCode] = useState(initial.zipCode)
  const [coverageStates, setCoverageStates] = useState<string[]>(initial.coverageStates)
  const [coverageStateInput, setCoverageStateInput] = useState('')
  const [counties, setCounties] = useState<string[]>(initial.counties)
  const [countyInput, setCountyInput] = useState('')
  const [primaryCounty, setPrimaryCounty] = useState(initial.primaryCounty)
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([])
  const [addressLookupError, setAddressLookupError] = useState('')

  const normalizedCoverageStates = useMemo(() => {
    const fromSelected = coverageStates.map((state) => state.toUpperCase()).filter(Boolean)
    if (stateCode && !fromSelected.includes(stateCode)) return [stateCode, ...fromSelected]
    return fromSelected
  }, [coverageStates, stateCode])

  const availableCountySuggestions = useMemo(() => {
    const merged = new Set<string>()
    const states = normalizedCoverageStates.length ? normalizedCoverageStates : stateCode ? [stateCode] : []
    for (const state of states) {
      for (const county of countiesByState[state] ?? []) {
        merged.add(county)
      }
    }

    const query = countyInput.toLowerCase().trim()
    return [...merged]
      .filter((county) => !counties.includes(county))
      .filter((county) => (!query ? true : county.toLowerCase().includes(query)))
      .slice(0, 30)
  }, [normalizedCoverageStates, stateCode, countiesByState, counties, countyInput])

  function handleAddressInput(nextValue: string) {
    setOfficeAddress(nextValue)
    if (!mapsEnabled) {
      setAddressSuggestions([])
      setAddressLookupError(
        nextValue.trim().length >= 3
          ? 'Address autocomplete is unavailable. Configure GMAPS_API_KEY and restart the server.'
          : ''
      )
      return
    }

    if (nextValue.trim().length < 3) {
      setAddressSuggestions([])
      setAddressLookupError('')
    }
  }

  useEffect(() => {
    if (!mapsEnabled) return

    const value = officeAddress.trim()
    if (value.length < 3) return

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/maps/autocomplete?input=${encodeURIComponent(value)}`)
        const payload = (await response.json()) as {
          ok?: boolean
          error?: string
          items?: AddressSuggestion[]
        }
        if (!payload.ok) {
          setAddressSuggestions([])
          setAddressLookupError(payload.error || 'Address lookup failed.')
          return
        }

        setAddressLookupError('')
        setAddressSuggestions(payload.items ?? [])
      } catch {
        setAddressSuggestions([])
      }
    }, 250)

    return () => window.clearTimeout(timer)
  }, [officeAddress, mapsEnabled])

  function addCoverageState(value: string) {
    const state = value.trim().toUpperCase()
    if (!state || coverageStates.includes(state)) return
    setCoverageStates((prev) => [...prev, state])
    setCoverageStateInput('')
  }

  function removeCoverageState(value: string) {
    const state = value.toUpperCase()
    setCoverageStates((prev) => prev.filter((item) => item !== state))
  }

  function addCounty(value: string) {
    const county = value.trim()
    if (!county || counties.includes(county)) return
    setCounties((prev) => [...prev, county])
    if (!primaryCounty) setPrimaryCounty(county)
    setCountyInput('')
  }

  function removeCounty(value: string) {
    setCounties((prev) => prev.filter((county) => county !== value))
    if (primaryCounty === value) setPrimaryCounty('')
  }

  async function selectAddressSuggestion(suggestion: AddressSuggestion) {
    if (!mapsEnabled) return

    setOfficeAddress(suggestion.description)
    setAddressSuggestions([])

    try {
      const response = await fetch(`/api/maps/place-details?placeId=${encodeURIComponent(suggestion.placeId)}`)
      const payload = (await response.json()) as {
        ok?: boolean
        error?: string
        details?: {
          formattedAddress?: string
          city?: string
          stateCode?: string
          county?: string
          zipCode?: string
        }
      }
      if (!payload.ok || !payload.details) {
        setAddressLookupError(payload.error || 'Could not verify selected address.')
        return
      }

      setAddressLookupError('')
      if (payload.details.formattedAddress) setOfficeAddress(payload.details.formattedAddress)
      if (payload.details.city) setCity(payload.details.city)
      if (payload.details.zipCode) setZipCode(payload.details.zipCode)

      if (payload.details.stateCode) {
        const normalizedState = payload.details.stateCode.toUpperCase()
        setStateCode(normalizedState)
        addCoverageState(normalizedState)
      }
      if (payload.details.county) addCounty(payload.details.county)
    } catch {
      setAddressLookupError('Could not verify selected address.')
    }
  }

  function validate() {
    const nextErrors: Record<string, string> = {}
    if (!fullName.trim()) nextErrors.fullName = 'Full name is required.'
    if (!email.includes('@')) nextErrors.email = 'Valid email is required.'
    if (!phone.trim()) nextErrors.phone = 'Phone is required.'
    if (!stateCode.trim()) nextErrors.state = 'Primary state is required.'
    if (!officeAddress.trim()) nextErrors.officeAddress = 'Office address is required.'
    if (!zipCode.trim()) nextErrors.zipCode = 'ZIP code is required.'
    if (!normalizedCoverageStates.length) nextErrors.coverageStates = 'Add at least one state.'
    if (!counties.length) nextErrors.counties = 'Add at least one county.'
    setErrors(nextErrors)
    return !Object.keys(nextErrors).length
  }

  return (
    <section className={styles.card}>
      <h2 style={{ margin: 0 }}>My Firm</h2>
      <p className={styles.sub}>
        Manage your attorney profile, verified office address, and coverage map for state and county assignments.
      </p>
      {message ? <p className="notice">{message}</p> : null}

      <form
        action={saveAttorneyFirmProfile}
        onSubmit={(event) => {
          if (!validate()) event.preventDefault()
        }}
        className={styles.form}
      >
        <div className={styles.grid}>
          <div className={styles.row}>
            <label className={styles.req}>Full Name</label>
            <input value={fullName} onChange={(event) => setFullName(event.target.value)} />
            {errors.fullName ? <p className={styles.err}>{errors.fullName}</p> : null}
          </div>
          <div className={styles.row}>
            <label className={styles.req}>Email</label>
            <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} />
            {errors.email ? <p className={styles.err}>{errors.email}</p> : null}
          </div>
          <div className={styles.row}>
            <label className={styles.req}>Phone</label>
            <input value={phone} onChange={(event) => setPhone(event.target.value)} />
            {errors.phone ? <p className={styles.err}>{errors.phone}</p> : null}
          </div>
          <div className={styles.row}>
            <label className={styles.req}>Primary State</label>
            <select value={stateCode} onChange={(event) => setStateCode(event.target.value)}>
              <option value="">Select...</option>
              {STATES.map(([value, label]) => (
                <option key={value} value={value}>
                  {label} ({value})
                </option>
              ))}
            </select>
            {errors.state ? <p className={styles.err}>{errors.state}</p> : null}
          </div>
          <div className={styles.row}>
            <label className={styles.req}>Office Address</label>
            <input
              value={officeAddress}
              onChange={(event) => handleAddressInput(event.target.value)}
              placeholder="Type address and select a verified suggestion"
            />
            {addressSuggestions.length ? (
              <div className={styles.suggest}>
                {addressSuggestions.map((item) => (
                  <button
                    key={item.placeId}
                    type="button"
                    className={styles.sItem}
                    onClick={() => void selectAddressSuggestion(item)}
                  >
                    {item.description}
                  </button>
                ))}
              </div>
            ) : null}
            {addressLookupError ? <p className={styles.err}>{addressLookupError}</p> : null}
            {!mapsEnabled ? (
              <p className={styles.hint}>
                Address autocomplete is disabled until <code>GMAPS_API_KEY</code> is configured.
              </p>
            ) : null}
            {errors.officeAddress ? <p className={styles.err}>{errors.officeAddress}</p> : null}
          </div>
          <div className={styles.row}>
            <label>City</label>
            <input value={city} onChange={(event) => setCity(event.target.value)} />
          </div>
          <div className={styles.row}>
            <label className={styles.req}>ZIP Code</label>
            <input value={zipCode} onChange={(event) => setZipCode(event.target.value)} />
            {errors.zipCode ? <p className={styles.err}>{errors.zipCode}</p> : null}
          </div>
        </div>

        <h3 className={styles.section}>Coverage States</h3>
        <div className={styles.inline}>
          <select value={coverageStateInput} onChange={(event) => setCoverageStateInput(event.target.value)}>
            <option value="">Select state to add...</option>
            {STATES.map(([value, label]) => (
              <option key={value} value={value}>
                {label} ({value})
              </option>
            ))}
          </select>
          <button type="button" className="secondary" onClick={() => addCoverageState(coverageStateInput)}>
            Add State
          </button>
        </div>
        {errors.coverageStates ? <p className={styles.err}>{errors.coverageStates}</p> : null}
        <div className={styles.chips}>
          {normalizedCoverageStates.map((state) => (
            <span key={state} className={styles.chip}>
              {state}
              <button type="button" onClick={() => removeCoverageState(state)}>
                x
              </button>
            </span>
          ))}
        </div>

        <h3 className={styles.section}>Coverage Counties</h3>
        <div className={styles.inline}>
          <input
            value={countyInput}
            onChange={(event) => setCountyInput(event.target.value)}
            placeholder="Type county name and press Add"
          />
          <button type="button" className="secondary" onClick={() => addCounty(countyInput)}>
            Add County
          </button>
        </div>
        {availableCountySuggestions.length ? (
          <div className={styles.suggest}>
            {availableCountySuggestions.map((county) => (
              <button key={county} type="button" className={styles.sItem} onClick={() => addCounty(county)}>
                {county}
              </button>
            ))}
          </div>
        ) : null}
        {errors.counties ? <p className={styles.err}>{errors.counties}</p> : null}

        <div className={styles.chips}>
          {counties.map((county) => (
            <span key={county} className={styles.chip}>
              {county}
              <button type="button" onClick={() => removeCounty(county)}>
                x
              </button>
            </span>
          ))}
        </div>

        <div className={styles.row}>
          <label>Primary County</label>
          <select value={primaryCounty} onChange={(event) => setPrimaryCounty(event.target.value)}>
            <option value="">Not set</option>
            {counties.map((county) => (
              <option key={county} value={county}>
                {county}
              </option>
            ))}
          </select>
        </div>

        <input type="hidden" name="full_name" value={fullName} />
        <input type="hidden" name="email" value={email} />
        <input type="hidden" name="phone" value={phone} />
        <input type="hidden" name="state" value={stateCode} />
        <input type="hidden" name="office_address" value={officeAddress} />
        <input type="hidden" name="city" value={city} />
        <input type="hidden" name="zip_code" value={zipCode} />
        <input type="hidden" name="counties_json" value={JSON.stringify(counties)} />
        <input type="hidden" name="coverage_states_json" value={JSON.stringify(normalizedCoverageStates)} />
        <input type="hidden" name="primary_county" value={primaryCounty} />

        <div className={styles.actions}>
          <button type="submit" className="primary">
            Save My Firm Profile
          </button>
        </div>
      </form>
    </section>
  )
}
