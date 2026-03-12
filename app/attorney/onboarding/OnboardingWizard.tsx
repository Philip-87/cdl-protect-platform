'use client'

import { useEffect, useMemo, useState } from 'react'
import { finishAttorneyOnboarding, saveAttorneyOnboardingStepTwo } from './actions'
import styles from './onboarding.module.css'

type CountyFeeRow = {
  county: string
  cdlFee: number | null
  nonCdlFee: number | null
}

type PaymentDetails = {
  achBankName: string
  achAccountNumber: string
  achRoutingNumber: string
  zelleContact: string
  lawpayAccount: string
  stripeAccount: string
  paypalContact: string
  otherDetails: string
}

type OnboardingInitial = {
  fullName: string
  email: string
  phone: string
  state: string
  officeAddress: string
  city: string
  zipCode: string
  paymentMethods: string[]
  paymentIdentifier: string
  otherPayment: string
  paymentDetails: PaymentDetails
  feeMode: 'GLOBAL' | 'BY_COUNTY'
  cdlFlatFee: string
  nonCdlFlatFee: string
  counties: string[]
  countyFees: CountyFeeRow[]
  agreedToTerms: boolean
  signatureText: string
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

const PAYMENT_METHODS = ['ACH', 'LawPay', 'Zelle', 'Stripe', 'PayPal', 'Other']
const TERMS_VERSION = '2026-02-29'

function parseNumberInput(value: string) {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function digitsOnly(value: string) {
  return value.replace(/\D+/g, '')
}

function toCountyLabel(value: string) {
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s+County$/i, '')
    .trim()
}

function buildPaymentIdentifier(paymentMethods: string[], paymentDetails: PaymentDetails, fallback: string) {
  if (paymentMethods.includes('ACH')) {
    const accountDigits = digitsOnly(paymentDetails.achAccountNumber)
    const tail = accountDigits ? accountDigits.slice(-4) : ''
    if (paymentDetails.achBankName && tail) {
      return `ACH - ${paymentDetails.achBankName} ****${tail}`
    }
    return 'ACH'
  }

  if (paymentMethods.includes('Zelle') && paymentDetails.zelleContact) {
    return `Zelle - ${paymentDetails.zelleContact}`
  }

  if (paymentMethods.includes('LawPay') && paymentDetails.lawpayAccount) {
    return `LawPay - ${paymentDetails.lawpayAccount}`
  }

  if (paymentMethods.includes('Stripe') && paymentDetails.stripeAccount) {
    return `Stripe - ${paymentDetails.stripeAccount}`
  }

  if (paymentMethods.includes('PayPal') && paymentDetails.paypalContact) {
    return `PayPal - ${paymentDetails.paypalContact}`
  }

  if (paymentMethods.includes('Other') && paymentDetails.otherDetails) {
    return `Other - ${paymentDetails.otherDetails}`
  }

  return fallback.trim()
}

export default function OnboardingWizard({
  initial,
  message,
  initialStep,
  suggestedCountiesByState,
  mapsEnabled,
  embedded = false,
}: {
  initial: OnboardingInitial
  message?: string
  initialStep: number
  suggestedCountiesByState: Record<string, string[]>
  mapsEnabled: boolean
  embedded?: boolean
}) {
  const [step, setStep] = useState(Math.min(4, Math.max(1, initialStep || 1)))
  const [errors, setErrors] = useState<Record<string, string>>({})

  const [fullName, setFullName] = useState(initial.fullName)
  const [email, setEmail] = useState(initial.email)
  const [phone, setPhone] = useState(initial.phone)
  const [stateCode, setStateCode] = useState(initial.state)
  const [officeAddress, setOfficeAddress] = useState(initial.officeAddress)
  const [city, setCity] = useState(initial.city)
  const [zipCode, setZipCode] = useState(initial.zipCode)
  const [paymentMethods, setPaymentMethods] = useState<string[]>(initial.paymentMethods)
  const [paymentIdentifier] = useState(initial.paymentIdentifier)
  const [otherPayment, setOtherPayment] = useState(initial.otherPayment)
  const [paymentDetails, setPaymentDetails] = useState<PaymentDetails>(initial.paymentDetails)
  const [feeMode, setFeeMode] = useState<'GLOBAL' | 'BY_COUNTY'>(initial.feeMode)
  const [cdlFlatFee, setCdlFlatFee] = useState(initial.cdlFlatFee)
  const [nonCdlFlatFee, setNonCdlFlatFee] = useState(initial.nonCdlFlatFee)
  const [counties, setCounties] = useState<string[]>(initial.counties)
  const [countyFees, setCountyFees] = useState<CountyFeeRow[]>(initial.countyFees)
  const [countyInput, setCountyInput] = useState('')
  const [agree, setAgree] = useState(initial.agreedToTerms)
  const [signatureText, setSignatureText] = useState(initial.signatureText)
  const [addressSuggestions, setAddressSuggestions] = useState<AddressSuggestion[]>([])
  const [addressLookupError, setAddressLookupError] = useState('')
  const [googleCountySuggestions, setGoogleCountySuggestions] = useState<string[]>([])
  const [countyLookupError, setCountyLookupError] = useState('')
  const [countyLookupPending, setCountyLookupPending] = useState(false)

  const suggested = useMemo(
    () => {
      const query = countyInput.toLowerCase().trim()
      const merged = new Set<string>()

      for (const county of suggestedCountiesByState[stateCode] || []) {
        merged.add(toCountyLabel(county))
      }

      for (const county of googleCountySuggestions) {
        merged.add(toCountyLabel(county))
      }

      return [...merged]
        .filter(Boolean)
        .filter((county) => !counties.includes(county))
        .filter((county) => (!query ? true : county.toLowerCase().includes(query)))
    },
    [stateCode, suggestedCountiesByState, counties, countyInput, googleCountySuggestions]
  )

  const countyFeeMap = useMemo(() => {
    const map = new Map<string, CountyFeeRow>()
    countyFees.forEach((row) => map.set(row.county, row))
    return map
  }, [countyFees])

  const normalizedCountyFees = counties.map((county) => {
    const existing = countyFeeMap.get(county)
    return existing || { county, cdlFee: null, nonCdlFee: null }
  })

  const resolvedPaymentIdentifier = buildPaymentIdentifier(paymentMethods, paymentDetails, paymentIdentifier)

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

  useEffect(() => {
    if (!mapsEnabled) {
      setGoogleCountySuggestions([])
      return
    }

    const query = countyInput.trim()
    if (query.length < 2 || !stateCode) {
      setGoogleCountySuggestions([])
      return
    }

    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(
          `/api/maps/county-suggest?input=${encodeURIComponent(query)}&state=${encodeURIComponent(stateCode)}`
        )
        const payload = (await response.json()) as {
          ok?: boolean
          error?: string
          items?: string[]
        }

        if (!payload.ok) {
          setGoogleCountySuggestions([])
          return
        }

        setGoogleCountySuggestions((payload.items ?? []).map((county) => toCountyLabel(county)).filter(Boolean))
      } catch {
        setGoogleCountySuggestions([])
      }
    }, 220)

    return () => window.clearTimeout(timer)
  }, [countyInput, stateCode, mapsEnabled])

  function togglePaymentMethod(method: string) {
    setPaymentMethods((prev) =>
      prev.includes(method) ? prev.filter((item) => item !== method) : [...prev, method]
    )
  }

  function updatePaymentDetail(field: keyof PaymentDetails, value: string) {
    setPaymentDetails((prev) => ({ ...prev, [field]: value }))
  }

  function addCounty(value: string) {
    const county = toCountyLabel(value)
    if (!county || counties.includes(county)) return
    setCounties((prev) => [...prev, county])
    setCountyInput('')
    setCountyLookupError('')
  }

  function removeCounty(value: string) {
    setCounties((prev) => prev.filter((county) => county !== value))
    setCountyFees((prev) => prev.filter((row) => row.county !== value))
  }

  async function handleAddCounty(rawValue?: string) {
    const candidate = toCountyLabel(rawValue ?? countyInput)
    if (!candidate) return
    if (counties.includes(candidate)) {
      setCountyInput('')
      return
    }

    const localMatch = suggested.some((county) => county.toLowerCase() === candidate.toLowerCase())
    if (localMatch || !mapsEnabled || !stateCode) {
      addCounty(candidate)
      return
    }

    setCountyLookupPending(true)
    setCountyLookupError('')
    try {
      const response = await fetch(
        `/api/maps/county-verify?county=${encodeURIComponent(candidate)}&state=${encodeURIComponent(stateCode)}`
      )
      const payload = (await response.json()) as {
        ok?: boolean
        error?: string
        county?: string
      }

      if (!payload.ok || !payload.county) {
        setCountyLookupError(payload.error || 'County could not be verified for the selected state.')
        return
      }

      addCounty(payload.county)
    } catch {
      setCountyLookupError('County verification failed. Please try again.')
    } finally {
      setCountyLookupPending(false)
    }
  }

  function updateCountyFee(county: string, field: 'cdlFee' | 'nonCdlFee', value: string) {
    const numeric = parseNumberInput(value)
    setCountyFees((prev) => {
      const existing = prev.find((row) => row.county === county) || {
        county,
        cdlFee: null,
        nonCdlFee: null,
      }
      const next: CountyFeeRow = { ...existing, [field]: numeric }
      return [...prev.filter((row) => row.county !== county), next]
    })
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
      if (payload.details.stateCode) setStateCode(payload.details.stateCode.toUpperCase())
      if (payload.details.county) addCounty(payload.details.county)
    } catch {
      setAddressLookupError('Could not verify selected address.')
    }
  }

  function validateStepOne() {
    const nextErrors: Record<string, string> = {}
    if (!fullName.trim()) nextErrors.fullName = 'Full name is required.'
    if (!email.includes('@')) nextErrors.email = 'Valid email is required.'
    if (!phone.trim()) nextErrors.phone = 'Phone is required.'
    if (!stateCode.trim()) nextErrors.state = 'State is required.'
    if (!officeAddress.trim()) nextErrors.officeAddress = 'Office address is required.'
    if (!zipCode.trim()) nextErrors.zipCode = 'ZIP code is required.'
    setErrors(nextErrors)
    return !Object.keys(nextErrors).length
  }

  function validateStepTwo() {
    const nextErrors: Record<string, string> = {}
    if (!paymentMethods.length) nextErrors.paymentMethods = 'Select at least one payment method.'
    if (!counties.length) nextErrors.counties = 'Add at least one county.'

    if (paymentMethods.includes('ACH')) {
      if (!paymentDetails.achBankName.trim()) {
        nextErrors.achBankName = 'Bank name is required for ACH.'
      }
      if (digitsOnly(paymentDetails.achRoutingNumber).length !== 9) {
        nextErrors.achRoutingNumber = 'ACH routing number must be 9 digits.'
      }
      if (digitsOnly(paymentDetails.achAccountNumber).length < 4) {
        nextErrors.achAccountNumber = 'ACH account number is required.'
      }
    }

    if (paymentMethods.includes('Zelle') && !paymentDetails.zelleContact.trim()) {
      nextErrors.zelleContact = 'Enter the email or phone linked to Zelle.'
    }

    if (paymentMethods.includes('LawPay') && !paymentDetails.lawpayAccount.trim()) {
      nextErrors.lawpayAccount = 'Enter your LawPay account identifier.'
    }

    if (paymentMethods.includes('Stripe') && !paymentDetails.stripeAccount.trim()) {
      nextErrors.stripeAccount = 'Enter your Stripe account identifier.'
    }

    if (paymentMethods.includes('PayPal') && !paymentDetails.paypalContact.trim()) {
      nextErrors.paypalContact = 'Enter your PayPal email or merchant id.'
    }

    if (paymentMethods.includes('Other') && !paymentDetails.otherDetails.trim() && !otherPayment.trim()) {
      nextErrors.otherDetails = 'Describe the other payment method.'
    }

    if (!resolvedPaymentIdentifier.trim()) {
      nextErrors.paymentIdentifier = 'Payment identifier is required.'
    }

    if (feeMode === 'GLOBAL') {
      if (!(parseNumberInput(cdlFlatFee) && parseNumberInput(cdlFlatFee)! > 0)) {
        nextErrors.cdlFlatFee = 'CDL fee must be a positive number.'
      }
      if (!(parseNumberInput(nonCdlFlatFee) && parseNumberInput(nonCdlFlatFee)! > 0)) {
        nextErrors.nonCdlFlatFee = 'Non-CDL fee must be a positive number.'
      }
    } else {
      const invalid = normalizedCountyFees.some(
        (row) => !(row.cdlFee && row.cdlFee > 0) || !(row.nonCdlFee && row.nonCdlFee > 0)
      )
      if (invalid) nextErrors.countyFees = 'Every selected county must have CDL and Non-CDL fees.'
    }

    setErrors(nextErrors)
    return !Object.keys(nextErrors).length
  }

  function validateStepThree() {
    const nextErrors: Record<string, string> = {}
    if (!agree) nextErrors.agree = 'You must agree to terms.'
    if (!signatureText.trim()) nextErrors.signatureText = 'Signature is required.'
    setErrors(nextErrors)
    return !Object.keys(nextErrors).length
  }

  return (
    <div className={styles.wrap}>
      <div className={`${styles.card} ${embedded ? styles.embedded : ''}`}>
        {!embedded ? <h1>Attorney Onboarding</h1> : null}
        {!embedded ? (
          <p className={styles.sub}>
            Complete profile, coverage, and agreement before using the attorney portal.
          </p>
        ) : (
          <p className={styles.sub}>
            Work through the operational setup in order: identity, payment details, county coverage, then the engagement agreement.
          </p>
        )}
        {message ? <p className="notice">{message}</p> : null}

        <div className={styles.steps}>
          <button type="button" className={`${styles.pillStep} ${step === 1 ? styles.on : ''}`} onClick={() => setStep(1)}>
            Step 1
          </button>
          <button type="button" className={`${styles.pillStep} ${step === 2 ? styles.on : ''}`} onClick={() => setStep(2)}>
            Step 2
          </button>
          <button type="button" className={`${styles.pillStep} ${step === 3 ? styles.on : ''}`} onClick={() => setStep(3)}>
            Step 3
          </button>
          <button type="button" className={`${styles.pillStep} ${step === 4 ? styles.on : ''}`} onClick={() => setStep(4)}>
            Done
          </button>
        </div>

        {(step === 1 || step === 2) && (
          <form
            action={saveAttorneyOnboardingStepTwo}
            onSubmit={(event) => {
              if (!validateStepOne() || !validateStepTwo()) {
                event.preventDefault()
                return
              }
              setStep(3)
            }}
            className={styles.form}
            id="onboarding-identity"
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
                <label className={styles.req}>State</label>
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
                  placeholder="Type address and pick a suggestion"
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

            <h3 className={styles.sectionTitle}>Payment</h3>
            <div className={styles.inline}>
              {PAYMENT_METHODS.map((method) => (
                <label key={method}>
                  <input
                    type="checkbox"
                    checked={paymentMethods.includes(method)}
                    onChange={() => togglePaymentMethod(method)}
                  />{' '}
                  {method}
                </label>
              ))}
            </div>
            {errors.paymentMethods ? <p className={styles.err}>{errors.paymentMethods}</p> : null}

            <div className={styles.grid}>
              {paymentMethods.includes('ACH') ? (
                <>
                  <div className={styles.row}>
                    <label className={styles.req}>ACH Bank Name</label>
                    <input
                      value={paymentDetails.achBankName}
                      onChange={(event) => updatePaymentDetail('achBankName', event.target.value)}
                      placeholder="Bank name"
                    />
                    {errors.achBankName ? <p className={styles.err}>{errors.achBankName}</p> : null}
                  </div>
                  <div className={styles.row}>
                    <label className={styles.req}>ACH Account Number</label>
                    <input
                      value={paymentDetails.achAccountNumber}
                      onChange={(event) => updatePaymentDetail('achAccountNumber', event.target.value)}
                      placeholder="Account number"
                    />
                    {errors.achAccountNumber ? <p className={styles.err}>{errors.achAccountNumber}</p> : null}
                  </div>
                  <div className={styles.row}>
                    <label className={styles.req}>ACH Routing Number</label>
                    <input
                      value={paymentDetails.achRoutingNumber}
                      onChange={(event) => updatePaymentDetail('achRoutingNumber', event.target.value)}
                      placeholder="9-digit routing number"
                    />
                    {errors.achRoutingNumber ? <p className={styles.err}>{errors.achRoutingNumber}</p> : null}
                  </div>
                </>
              ) : null}

              {paymentMethods.includes('Zelle') ? (
                <div className={styles.row}>
                  <label className={styles.req}>Zelle Contact</label>
                  <input
                    value={paymentDetails.zelleContact}
                    onChange={(event) => updatePaymentDetail('zelleContact', event.target.value)}
                    placeholder="Email or phone linked to Zelle"
                  />
                  {errors.zelleContact ? <p className={styles.err}>{errors.zelleContact}</p> : null}
                </div>
              ) : null}

              {paymentMethods.includes('LawPay') ? (
                <div className={styles.row}>
                  <label className={styles.req}>LawPay Identifier</label>
                  <input
                    value={paymentDetails.lawpayAccount}
                    onChange={(event) => updatePaymentDetail('lawpayAccount', event.target.value)}
                    placeholder="LawPay account id/email"
                  />
                  {errors.lawpayAccount ? <p className={styles.err}>{errors.lawpayAccount}</p> : null}
                </div>
              ) : null}

              {paymentMethods.includes('Stripe') ? (
                <div className={styles.row}>
                  <label className={styles.req}>Stripe Identifier</label>
                  <input
                    value={paymentDetails.stripeAccount}
                    onChange={(event) => updatePaymentDetail('stripeAccount', event.target.value)}
                    placeholder="Stripe account id/email"
                  />
                  {errors.stripeAccount ? <p className={styles.err}>{errors.stripeAccount}</p> : null}
                </div>
              ) : null}

              {paymentMethods.includes('PayPal') ? (
                <div className={styles.row}>
                  <label className={styles.req}>PayPal Contact</label>
                  <input
                    value={paymentDetails.paypalContact}
                    onChange={(event) => updatePaymentDetail('paypalContact', event.target.value)}
                    placeholder="PayPal email or merchant id"
                  />
                  {errors.paypalContact ? <p className={styles.err}>{errors.paypalContact}</p> : null}
                </div>
              ) : null}

              {paymentMethods.includes('Other') ? (
                <div className={styles.row}>
                  <label className={styles.req}>Other Payment Method Details</label>
                  <input
                    value={paymentDetails.otherDetails}
                    onChange={(event) => {
                      updatePaymentDetail('otherDetails', event.target.value)
                      setOtherPayment(event.target.value)
                    }}
                    placeholder="Describe payment method and identifier"
                  />
                  {errors.otherDetails ? <p className={styles.err}>{errors.otherDetails}</p> : null}
                </div>
              ) : null}
            </div>

            <div className={styles.row}>
              <label className={styles.req}>Payment Identifier</label>
              <input value={resolvedPaymentIdentifier} readOnly />
              <p className={styles.hint}>Generated from the selected payment method details.</p>
              {errors.paymentIdentifier ? <p className={styles.err}>{errors.paymentIdentifier}</p> : null}
            </div>

            <h3 className={styles.sectionTitle} id="onboarding-pricing">Counties and Fees</h3>
            <div className={styles.row}>
              <label className={styles.req}>Add County</label>
              <div className={styles.inline}>
                <input
                  value={countyInput}
                  onChange={(event) => {
                    setCountyInput(event.target.value)
                    setCountyLookupError('')
                  }}
                  placeholder="Type county and press Add"
                />
                <button
                  type="button"
                  className="secondary"
                  onClick={() => void handleAddCounty()}
                  disabled={countyLookupPending}
                >
                  {countyLookupPending ? 'Verifying...' : 'Add'}
                </button>
              </div>
              {suggested.length ? (
                <div className={styles.suggest}>
                  {suggested.slice(0, 20).map((county) => (
                    <button
                      key={county}
                      type="button"
                      className={styles.sItem}
                      onClick={() => void handleAddCounty(county)}
                    >
                      {county}
                    </button>
                  ))}
                </div>
              ) : null}
              {countyLookupError ? <p className={styles.err}>{countyLookupError}</p> : null}
              {errors.counties ? <p className={styles.err}>{errors.counties}</p> : null}
            </div>

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

            <div className={styles.inline}>
              <label>
                <input type="radio" checked={feeMode === 'GLOBAL'} onChange={() => setFeeMode('GLOBAL')} /> Global Fees
              </label>
              <label>
                <input type="radio" checked={feeMode === 'BY_COUNTY'} onChange={() => setFeeMode('BY_COUNTY')} /> County
                Fees
              </label>
            </div>

            {feeMode === 'GLOBAL' ? (
              <div className={styles.grid}>
                <div className={styles.row}>
                  <label className={styles.req}>CDL Flat Fee</label>
                  <input value={cdlFlatFee} onChange={(event) => setCdlFlatFee(event.target.value)} />
                  {errors.cdlFlatFee ? <p className={styles.err}>{errors.cdlFlatFee}</p> : null}
                </div>
                <div className={styles.row}>
                  <label className={styles.req}>Non-CDL Flat Fee</label>
                  <input value={nonCdlFlatFee} onChange={(event) => setNonCdlFlatFee(event.target.value)} />
                  {errors.nonCdlFlatFee ? <p className={styles.err}>{errors.nonCdlFlatFee}</p> : null}
                </div>
              </div>
            ) : (
              <div className={styles.scrollBox}>
                <table>
                  <thead>
                    <tr>
                      <th>County</th>
                      <th>CDL Fee</th>
                      <th>Non-CDL Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {normalizedCountyFees.map((row) => (
                      <tr key={row.county}>
                        <td>{row.county}</td>
                        <td>
                          <input
                            value={row.cdlFee ?? ''}
                            onChange={(event) => updateCountyFee(row.county, 'cdlFee', event.target.value)}
                          />
                        </td>
                        <td>
                          <input
                            value={row.nonCdlFee ?? ''}
                            onChange={(event) => updateCountyFee(row.county, 'nonCdlFee', event.target.value)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {errors.countyFees ? <p className={styles.err}>{errors.countyFees}</p> : null}
              </div>
            )}

            <input type="hidden" name="full_name" value={fullName} />
            <input type="hidden" name="email" value={email} />
            <input type="hidden" name="phone" value={phone} />
            <input type="hidden" name="state" value={stateCode} />
            <input type="hidden" name="office_address" value={officeAddress} />
            <input type="hidden" name="city" value={city} />
            <input type="hidden" name="zip_code" value={zipCode} />
            <input type="hidden" name="payment_methods_json" value={JSON.stringify(paymentMethods)} />
            <input type="hidden" name="payment_identifier" value={resolvedPaymentIdentifier} />
            <input type="hidden" name="payment_details_json" value={JSON.stringify(paymentDetails)} />
            <input type="hidden" name="other_payment" value={otherPayment} />
            <input type="hidden" name="fee_mode" value={feeMode} />
            <input type="hidden" name="cdl_flat_fee" value={cdlFlatFee} />
            <input type="hidden" name="non_cdl_flat_fee" value={nonCdlFlatFee} />
            <input type="hidden" name="counties_json" value={JSON.stringify(counties)} />
            <input type="hidden" name="county_fees_json" value={JSON.stringify(normalizedCountyFees)} />

            <div className={styles.btns}>
              {step === 1 ? (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    if (validateStepOne()) setStep(2)
                  }}
                >
                  Continue
                </button>
              ) : null}
              {step === 2 ? (
                <button type="submit" className="primary">
                  Save & Continue
                </button>
              ) : null}
            </div>
          </form>
        )}

        {(step === 3 || step === 4) && (
          <form
            action={finishAttorneyOnboarding}
            onSubmit={(event) => {
              if (!validateStepThree()) {
                event.preventDefault()
                return
              }
              setStep(4)
            }}
            className={styles.form}
            id="onboarding-agreement"
          >
            <h3 className={styles.sectionTitle}>Attorney Agreement</h3>
            <div className={styles.agreementBox}>
              <h4>Attorney Service Agreement</h4>
              <p>
                By signing this agreement, you confirm that you are authorized to represent clients in the selected
                jurisdictions and will provide timely case updates and disposition details.
              </p>
              <ul>
                <li>You accept assignments only within your licensed scope.</li>
                <li>You maintain accurate contact and payment information.</li>
                <li>You provide status updates and final outcomes promptly.</li>
                <li>You comply with all applicable legal and ethical obligations.</li>
              </ul>
            </div>

            <div className={styles.inline}>
              <label>
                <input type="checkbox" checked={agree} onChange={(event) => setAgree(event.target.checked)} /> I agree
                to the terms
              </label>
            </div>
            {errors.agree ? <p className={styles.err}>{errors.agree}</p> : null}

            <div className={styles.row}>
              <label className={styles.req}>Type full legal name as signature</label>
              <input value={signatureText} onChange={(event) => setSignatureText(event.target.value)} />
              {errors.signatureText ? <p className={styles.err}>{errors.signatureText}</p> : null}
            </div>

            <input type="hidden" name="signature_text" value={signatureText} />
            <input type="hidden" name="agreed_to_terms" value={agree ? 'true' : 'false'} />
            <input type="hidden" name="terms_version" value={TERMS_VERSION} />

            <div className={styles.btns}>
              <button type="button" className="secondary" onClick={() => setStep(2)}>
                Back
              </button>
              <button type="submit" className="primary">
                Finish Onboarding
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}
