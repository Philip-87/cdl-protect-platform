'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { isAgencyRole, isDriverRole, type PlatformRole } from '@/app/lib/roles'
import styles from './intake-wizard.module.css'
import { submitIntake } from './actions'

type IntakeWizardProps = {
  message?: string
  fleets?: Array<{ id: string; company_name: string }>
  defaultFleetId?: string
  role?: PlatformRole
}

const STEPS = [
  { key: 'upload', title: 'Upload Ticket', subtitle: 'Add files for OCR pull' },
  { key: 'driver', title: 'Driver Details', subtitle: 'Contact and driver profile' },
  { key: 'ticket', title: 'Ticket Facts', subtitle: 'Violation essentials' },
  { key: 'court', title: 'Court Details', subtitle: 'Court schedule and notes' },
  { key: 'review', title: 'Review + Send', subtitle: 'Final quality check' },
]

const REQUIRED_FIELDS = [
  'first_name',
  'last_name',
  'citation_number',
  'violation_types',
  'date_of_violation',
  'state',
  'cdl_driver',
  'while_driving_commercial_vehicle',
]

const STEP_REQUIRED: Record<number, string[]> = {
  0: [],
  1: ['first_name', 'last_name'],
  2: ['citation_number', 'violation_types', 'date_of_violation', 'state', 'cdl_driver', 'while_driving_commercial_vehicle'],
  3: [],
  4: REQUIRED_FIELDS,
}

const LOW_OCR_CONFIDENCE_THRESHOLD = 0.6

const INITIAL_FORM = {
  first_name: '',
  last_name: '',
  email: '',
  phone_number: '',
  did_receive_ticket: 'Yes',
  citation_number: '',
  violation_types: '',
  date_of_violation: '',
  state: '',
  accident: 'No',
  injuries: 'No',
  fatality: 'No',
  towing: 'No',
  cdl_driver: '',
  while_driving_commercial_vehicle: '',
  court_id: '',
  do_you_have_court_date: 'Yes',
  court_date: '',
  court_time: '',
  court_address: '',
  court_county: '',
  notes: '',
  show_paid_pricing_to_fleet_driver: 'No',
  keep_agency_as_primary_contact: 'Yes',
}

type PricingPreviewState = {
  loading: boolean
  available: boolean | null
  message: string
  attorneyFeeCents: number
  platformFeeCents: number
  totalCents: number
}

function labelFor(name: string) {
  return name
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export default function IntakeWizard({
  message,
  fleets = [],
  defaultFleetId = '',
  role = 'NONE',
}: IntakeWizardProps) {
  const showPricingVisibilityToggle = role !== 'ATTORNEY' && !isDriverRole(role)
  const showAgencyPrimaryToggle = !isDriverRole(role) && (isAgencyRole(role) || role === 'FLEET')
  const [form, setForm] = useState(() => ({
    ...INITIAL_FORM,
    keep_agency_as_primary_contact: showAgencyPrimaryToggle ? INITIAL_FORM.keep_agency_as_primary_contact : 'No',
  }))
  const [activeStep, setActiveStep] = useState(0)
  const [filesCount, setFilesCount] = useState(0)
  const [fileLabel, setFileLabel] = useState('No files selected')
  const [uploadProgress, setUploadProgress] = useState(0)
  const [stepAlert, setStepAlert] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [ocrLoading, setOcrLoading] = useState(false)
  const [ocrMessage, setOcrMessage] = useState('')
  const [ocrWarning, setOcrWarning] = useState('')
  const [ocrPreviewTokens, setOcrPreviewTokens] = useState<string[]>([])
  const [pricingPreview, setPricingPreview] = useState<PricingPreviewState>({
    loading: false,
    available: null,
    message: '',
    attorneyFeeCents: 0,
    platformFeeCents: 0,
    totalCents: 0,
  })
  const uploadTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const completedRequired = useMemo(
    () =>
      REQUIRED_FIELDS.filter((field) => {
        const value = form[field as keyof typeof form]
        return String(value || '').trim().length > 0
      }).length,
    [form]
  )

  const readiness = Math.round((completedRequired / REQUIRED_FIELDS.length) * 100)
  const points = completedRequired * 120 + (filesCount > 0 ? 300 : 0)

  const tier = readiness >= 100 ? 'Dispatch Ready' : readiness >= 70 ? 'Road Warrior' : 'Warm-Up'

  useEffect(() => {
    return () => {
      if (uploadTimerRef.current) clearInterval(uploadTimerRef.current)
    }
  }, [])

  useEffect(() => {
    setForm((prev) => {
      const nextShowPricing = showPricingVisibilityToggle ? prev.show_paid_pricing_to_fleet_driver : 'No'
      const nextKeepAgency = showAgencyPrimaryToggle ? prev.keep_agency_as_primary_contact : 'No'

      if (
        nextShowPricing === prev.show_paid_pricing_to_fleet_driver &&
        nextKeepAgency === prev.keep_agency_as_primary_contact
      ) {
        return prev
      }

      return {
        ...prev,
        show_paid_pricing_to_fleet_driver: nextShowPricing,
        keep_agency_as_primary_contact: nextKeepAgency,
      }
    })
  }, [showAgencyPrimaryToggle, showPricingVisibilityToggle])

  useEffect(() => {
    if (activeStep !== 4) return

    const state = String(form.state || '').trim()
    const county = String(form.court_county || '').trim()
    const cdlDriver = String(form.cdl_driver || '').trim().toLowerCase() === 'yes'

    if (!state || !county || !String(form.cdl_driver || '').trim()) {
      setPricingPreview({
        loading: false,
        available: null,
        message: 'Complete state, county, and CDL fields to preview pricing or quote routing.',
        attorneyFeeCents: 0,
        platformFeeCents: 0,
        totalCents: 0,
      })
      return
    }

    const controller = new AbortController()
    setPricingPreview((prev) => ({ ...prev, loading: true, message: 'Checking attorney pricing for this court...' }))

    void fetch('/api/intake/pricing-preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state,
        county,
        cdlDriver,
      }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json().catch(() => ({}))) as {
          ok?: boolean
          pricingAvailable?: boolean
          attorneyFeeCents?: number
          platformFeeCents?: number
          totalCents?: number
          message?: string
          error?: string
        }
        if (!response.ok || !payload.ok) {
          throw new Error(payload.error || 'Pricing preview failed.')
        }

        setPricingPreview({
          loading: false,
          available: payload.pricingAvailable === true,
          message: String(payload.message ?? '').trim(),
          attorneyFeeCents: Number(payload.attorneyFeeCents ?? 0),
          platformFeeCents: Number(payload.platformFeeCents ?? 0),
          totalCents: Number(payload.totalCents ?? 0),
        })
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return
        setPricingPreview({
          loading: false,
          available: null,
          message: error instanceof Error ? error.message : 'Pricing preview failed.',
          attorneyFeeCents: 0,
          platformFeeCents: 0,
          totalCents: 0,
        })
      })

    return () => controller.abort()
  }, [activeStep, form.cdl_driver, form.court_county, form.state])

  function updateField(name: keyof typeof INITIAL_FORM, value: string) {
    setForm((prev) => ({ ...prev, [name]: value }))
  }

  function normalizeDateToInput(value: string) {
    const s = String(value || '').trim()
    if (!s) return ''
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

    const mdy = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/
    if (mdy.test(s)) {
      const [, mm, dd, yy] = s.match(mdy) ?? []
      const year = yy.length === 2 ? `20${yy}` : yy
      return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`
    }

    const d = new Date(s)
    if (!Number.isNaN(+d)) {
      const y = d.getFullYear()
      const m = String(d.getMonth() + 1).padStart(2, '0')
      const day = String(d.getDate()).padStart(2, '0')
      return `${y}-${m}-${day}`
    }

    return ''
  }

  function normalizeTimeToInput(value: string) {
    const s = String(value || '').trim()
    if (!s) return ''

    const first = s.split(/\s+AND\s+/i)[0]?.trim() || s
    if (/^\d{2}:\d{2}$/.test(first)) return first

    const hm = /^(\d{1,2}):(\d{2})$/
    if (hm.test(first)) {
      const [, h, mi] = first.match(hm) ?? []
      return `${String(h).padStart(2, '0')}:${mi}`
    }

    const ampm = /^(\d{1,2})(?::(\d{2}))?\s*([AaPp][Mm])$/
    if (ampm.test(first)) {
      const [, hh, mm = '00', ap] = first.match(ampm) ?? []
      let H = Number(hh)
      if (ap.toUpperCase() === 'PM' && H < 12) H += 12
      if (ap.toUpperCase() === 'AM' && H === 12) H = 0
      return `${String(H).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    }

    return ''
  }

  function applyOcrPrefill(fields: Record<string, unknown>) {
    setForm((prev) => {
      const next = { ...prev }
      const patch: Record<keyof typeof INITIAL_FORM, string> = {
        first_name: String(fields.firstName || ''),
        last_name: String(fields.lastName || ''),
        email: String(fields.brokersEmailTmp || ''),
        citation_number: String(fields.ticket || ''),
        violation_types: String(fields.violationTypes || fields.violationType || ''),
        date_of_violation: normalizeDateToInput(String(fields.dateOfViolation || '')),
        state: String(fields.state || '').toUpperCase(),
        court_id: String(fields.court_id || ''),
        court_date: normalizeDateToInput(String(fields.courtDate || '')),
        court_time: normalizeTimeToInput(String(fields.courtTime || '')),
        court_address: String(fields.courtAddress || ''),
        court_county: String(fields.courtCounty || ''),
        phone_number: prev.phone_number,
        did_receive_ticket: prev.did_receive_ticket,
        accident: prev.accident,
        injuries: prev.injuries,
        fatality: prev.fatality,
        towing: prev.towing,
        cdl_driver: prev.cdl_driver,
        while_driving_commercial_vehicle: prev.while_driving_commercial_vehicle,
        do_you_have_court_date: prev.do_you_have_court_date,
        show_paid_pricing_to_fleet_driver: prev.show_paid_pricing_to_fleet_driver,
        keep_agency_as_primary_contact: prev.keep_agency_as_primary_contact,
        notes: prev.notes,
      }

      ;(Object.keys(patch) as Array<keyof typeof INITIAL_FORM>).forEach((key) => {
        const incoming = String(patch[key] || '').trim()
        const current = String(prev[key] || '').trim()
        if (incoming && !current) {
          next[key] = patch[key]
        }
      })

      return next
    })
  }

  async function runOcrPreview(file: File) {
    setOcrLoading(true)
    setOcrWarning('')
    setOcrMessage('We are reading the fields from your ticket now. This can take up to a minute.')

    try {
      const fd = new FormData()
      fd.append('file', file)

      const response = await fetch('/api/intake/ocr-preview', {
        method: 'POST',
        body: fd,
        credentials: 'include',
        cache: 'no-store',
      })

      const payload = await response.json().catch(() => ({}))
      const lastError = payload?.error || `${response.status} ${response.statusText}` || 'OCR preview failed.'

      if (!response.ok || !payload?.ok) {
        if (/ALPN|Failed to fetch|NetworkError/i.test(lastError)) {
          setOcrMessage(
            'OCR preview network error. Open app at http://127.0.0.1:3000 and retry file upload for instant prefill.'
          )
          return
        }

        setOcrMessage(`OCR preview failed: ${lastError}`)
        return
      }

      applyOcrPrefill(payload.fields || {})
      const confidence = Number(payload.confidence || 0)
      const confidencePercent = Math.round(confidence * 100)
      const lowConfidence = confidence < LOW_OCR_CONFIDENCE_THRESHOLD
      setOcrPreviewTokens(payload.previewToken ? [String(payload.previewToken)] : [])
      setOcrMessage(
        lowConfidence
          ? `OCR finished with limited confidence (${confidencePercent}%). Review every field before you submit. Final submit will reuse this preview for the same file.`
          : `OCR preview is ready (${confidencePercent}% confidence). Empty fields were filled where the ticket was clear, and submit will reuse this result for the same file.`
      )
      setOcrWarning(
        lowConfidence ? 'OCR confidence is below 60%. Upload a brighter, straighter image for better field extraction.' : ''
      )
      setUploadProgress(100)
    } catch (error) {
      setOcrWarning('')
      setOcrMessage(`OCR preview failed: ${error instanceof Error ? error.message : 'Unknown error'}`)
    } finally {
      setOcrLoading(false)
    }
  }

  function onUploadChange(event: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? [])
    if (uploadTimerRef.current) clearInterval(uploadTimerRef.current)
    setFilesCount(files.length)
    setFileLabel(files.length ? files.map((f) => f.name).join(', ') : 'No files selected')
    setOcrWarning('')
    setOcrMessage('')
    setOcrPreviewTokens([])

    if (!files.length) {
      setUploadProgress(0)
      return
    }

    setUploadProgress(12)
    uploadTimerRef.current = setInterval(() => {
      setUploadProgress((prev) => {
        if (prev >= 100) {
          if (uploadTimerRef.current) clearInterval(uploadTimerRef.current)
          return 100
        }
        const next = prev + Math.max(2, Math.round((100 - prev) * 0.16))
        return next > 100 ? 100 : next
      })
    }, 180)

    void runOcrPreview(files[0])
  }

  function validateStep(step: number) {
    const required = STEP_REQUIRED[step] || []
    const missing = required.filter((field) => String(form[field as keyof typeof form] || '').trim().length === 0)

    if (!missing.length) {
      setStepAlert('')
      return true
    }

    setStepAlert(`Complete required fields first: ${missing.map(labelFor).join(', ')}`)
    return false
  }

  function goNext() {
    if (!validateStep(activeStep)) return
    setActiveStep((prev) => Math.min(prev + 1, STEPS.length - 1))
  }

  function goBack() {
    setStepAlert('')
    setActiveStep((prev) => Math.max(prev - 1, 0))
  }

  function jumpTo(step: number) {
    if (step > activeStep && !validateStep(activeStep)) return
    setStepAlert('')
    setActiveStep(step)
  }

  return (
    <form
      action={submitIntake}
      className={styles.wizard}
      onSubmit={() => setSubmitting(true)}
    >
      <input type="hidden" name="did_receive_ticket" value="Yes" />
      <input type="hidden" name="show_paid_pricing_to_fleet_driver" value={form.show_paid_pricing_to_fleet_driver} />
      <input type="hidden" name="keep_agency_as_primary_contact" value={form.keep_agency_as_primary_contact} />
      {ocrPreviewTokens.map((token, index) => (
        <input key={`${token}-${index}`} type="hidden" name="ocr_preview_token" value={token} />
      ))}
      <aside className={styles.sidebar}>
        <p className={styles.kicker}>Case Quest</p>
        <h2 className={styles.sideTitle}>Intake Progress</h2>
        <p className={styles.scoreLine}>
          <strong>{points} pts</strong> | {tier}
        </p>
        <div className={styles.progressTrack} aria-hidden="true">
          <div className={styles.progressFill} style={{ width: `${readiness}%` }} />
        </div>
        <p className={styles.readinessText}>{readiness}% readiness</p>

        <nav className={styles.stepNav} aria-label="Intake Steps">
          {STEPS.map((step, index) => {
            const isActive = index === activeStep
            const isDone = index < activeStep
            return (
              <button
                key={step.key}
                type="button"
                className={`${styles.stepButton} ${isActive ? styles.stepButtonActive : ''} ${isDone ? styles.stepButtonDone : ''}`}
                onClick={() => jumpTo(index)}
              >
                <span className={styles.stepIndex}>{isDone ? 'OK' : index + 1}</span>
                <span>
                  <strong>{step.title}</strong>
                  <small>{step.subtitle}</small>
                </span>
              </button>
            )
          })}
        </nav>
      </aside>

      <section className={styles.panel}>
        {message ? <p className="notice">{message}</p> : null}
        {stepAlert ? <p className={styles.stepAlert}>{stepAlert}</p> : null}

        <section className={`${styles.screen} ${activeStep === 0 ? styles.screenActive : ''}`} aria-hidden={activeStep !== 0}>
          <h3>Step 1: Upload Ticket Files</h3>
          <p className={styles.screenHint}>Preview OCR starts automatically after upload. Reading the ticket and filling fields can take up to a minute.</p>

          <label htmlFor="ticket_files">Ticket Documents / Images</label>
          <input id="ticket_files" name="ticket_files" type="file" multiple accept=".pdf,image/*" onChange={onUploadChange} />
          <p className={styles.fileLabel}>{fileLabel}</p>

          {filesCount > 0 ? (
            <div
              className={`${styles.ocrStatus} ${ocrLoading ? styles.ocrStatusLoading : ocrWarning ? styles.ocrStatusWarning : styles.ocrStatusReady}`}
              aria-live="polite"
            >
              <div className={styles.ocrStatusHead}>
                <span className={styles.ocrSpinner} aria-hidden="true" />
                <div>
                  <p className={styles.ocrTitle}>{ocrLoading ? 'Reading ticket fields' : 'OCR preview update'}</p>
                  <p className={styles.ocrCopy}>
                    {ocrLoading
                      ? 'Our system is reading the fields from the ticket now. It may take up to a minute to fill everything in.'
                      : ocrMessage || 'Upload a ticket image to start OCR preview.'}
                  </p>
                </div>
              </div>
              <div className={styles.uploadMeter}>
                <div className={styles.uploadMeterBar} style={{ width: `${uploadProgress}%` }} />
                <span>
                  {ocrLoading
                    ? `Running OCR ${Math.max(uploadProgress, 20)}%`
                    : uploadProgress < 100
                      ? `Analyzing files ${uploadProgress}%`
                      : 'OCR preview complete'}
                </span>
              </div>
              {ocrLoading ? (
                <div className={styles.ocrPulse} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </div>
              ) : null}
              {ocrWarning ? <p className={styles.ocrWarning}>{ocrWarning}</p> : null}
            </div>
          ) : null}
        </section>

        <section className={`${styles.screen} ${activeStep === 1 ? styles.screenActive : ''}`} aria-hidden={activeStep !== 1}>
          <h3>Step 2: Driver Details</h3>
          <p className={styles.screenHint}>Broker fields are intentionally removed for logged-in internal intake.</p>

          <div className={styles.grid2}>
            <div>
              <label htmlFor="first_name">First Name (required)</label>
              <input id="first_name" name="first_name" required value={form.first_name} onChange={(e) => updateField('first_name', e.target.value)} />
            </div>
            <div>
              <label htmlFor="last_name">Last Name (required)</label>
              <input id="last_name" name="last_name" required value={form.last_name} onChange={(e) => updateField('last_name', e.target.value)} />
            </div>
            <div>
              <label htmlFor="email">Driver Email</label>
              <input id="email" name="email" type="email" placeholder="driver@email.com" value={form.email} onChange={(e) => updateField('email', e.target.value)} />
            </div>
            <div>
              <label htmlFor="phone_number">Driver Phone</label>
              <input id="phone_number" name="phone_number" placeholder="(555) 555-5555" value={form.phone_number} onChange={(e) => updateField('phone_number', e.target.value)} />
            </div>
            {fleets.length ? (
              <div className={styles.full}>
                <label htmlFor="fleet_id">Fleet (optional)</label>
                <select id="fleet_id" name="fleet_id" defaultValue={defaultFleetId}>
                  <option value="">Use my default fleet</option>
                  {fleets.map((fleet) => (
                    <option key={fleet.id} value={fleet.id}>
                      {fleet.company_name}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}
          </div>
        </section>

        <section className={`${styles.screen} ${activeStep === 2 ? styles.screenActive : ''}`} aria-hidden={activeStep !== 2}>
          <h3>Step 3: Ticket Details</h3>
          <div className={styles.grid2}>
            <div>
              <label htmlFor="citation_number">Citation Number (required)</label>
              <input id="citation_number" name="citation_number" required value={form.citation_number} onChange={(e) => updateField('citation_number', e.target.value)} />
            </div>
            <div>
              <label htmlFor="violation_types">Violation Types (required)</label>
              <input id="violation_types" name="violation_types" required value={form.violation_types} onChange={(e) => updateField('violation_types', e.target.value)} />
            </div>
            <div>
              <label htmlFor="date_of_violation">Date of Violation (required)</label>
              <input id="date_of_violation" name="date_of_violation" type="date" required value={form.date_of_violation} onChange={(e) => updateField('date_of_violation', e.target.value)} />
            </div>
            <div>
              <label htmlFor="state">State (required)</label>
              <input id="state" name="state" required maxLength={2} placeholder="CA" value={form.state} onChange={(e) => updateField('state', e.target.value.toUpperCase())} />
            </div>
            <div>
              <label htmlFor="accident">Accident?</label>
              <select id="accident" name="accident" value={form.accident} onChange={(e) => updateField('accident', e.target.value)}>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="injuries">Injuries?</label>
              <select id="injuries" name="injuries" value={form.injuries} onChange={(e) => updateField('injuries', e.target.value)}>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="fatality">Fatality?</label>
              <select id="fatality" name="fatality" value={form.fatality} onChange={(e) => updateField('fatality', e.target.value)}>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="towing">Towing?</label>
              <select id="towing" name="towing" value={form.towing} onChange={(e) => updateField('towing', e.target.value)}>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="cdl_driver">CDL Driver? (required)</label>
              <select id="cdl_driver" name="cdl_driver" required value={form.cdl_driver} onChange={(e) => updateField('cdl_driver', e.target.value)}>
                <option value="" disabled>Select</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="while_driving_commercial_vehicle">Commercial Vehicle? (required)</label>
              <select id="while_driving_commercial_vehicle" name="while_driving_commercial_vehicle" required value={form.while_driving_commercial_vehicle} onChange={(e) => updateField('while_driving_commercial_vehicle', e.target.value)}>
                <option value="" disabled>Select</option>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
          </div>
        </section>

        <section className={`${styles.screen} ${activeStep === 3 ? styles.screenActive : ''}`} aria-hidden={activeStep !== 3}>
          <h3>Step 4: Court Information</h3>
          <div className={styles.grid2}>
            <div>
              <label htmlFor="court_id">Court Name / ID</label>
              <input id="court_id" name="court_id" value={form.court_id} onChange={(e) => updateField('court_id', e.target.value)} />
            </div>
            <div>
              <label htmlFor="do_you_have_court_date">Do you have a court date?</label>
              <select id="do_you_have_court_date" name="do_you_have_court_date" value={form.do_you_have_court_date} onChange={(e) => updateField('do_you_have_court_date', e.target.value)}>
                <option value="Yes">Yes</option>
                <option value="No">No</option>
              </select>
            </div>
            <div>
              <label htmlFor="court_date">Court Date</label>
              <input id="court_date" name="court_date" type="date" value={form.court_date} onChange={(e) => updateField('court_date', e.target.value)} />
            </div>
            <div>
              <label htmlFor="court_time">Court Time</label>
              <input id="court_time" name="court_time" type="time" value={form.court_time} onChange={(e) => updateField('court_time', e.target.value)} />
            </div>
            <div className={styles.full}>
              <label htmlFor="court_address">Court Address</label>
              <input id="court_address" name="court_address" value={form.court_address} onChange={(e) => updateField('court_address', e.target.value)} />
            </div>
            <div className={styles.full}>
              <label htmlFor="court_county">Court County</label>
              <input id="court_county" name="court_county" value={form.court_county} onChange={(e) => updateField('court_county', e.target.value)} />
            </div>
            <div className={styles.full}>
              <label htmlFor="notes">Notes</label>
              <textarea id="notes" name="notes" rows={4} value={form.notes} onChange={(e) => updateField('notes', e.target.value)} />
            </div>
          </div>
        </section>

        <section className={`${styles.screen} ${activeStep === 4 ? styles.screenActive : ''}`} aria-hidden={activeStep !== 4}>
          <h3>Step 5: Review + Submit</h3>
          <div className={styles.reviewCard}>
            <p><strong>Driver:</strong> {form.first_name || '-'} {form.last_name || ''}</p>
            <p><strong>Citation:</strong> {form.citation_number || '-'}</p>
            <p><strong>Violation:</strong> {form.violation_types || '-'}</p>
            <p><strong>State/Date:</strong> {(form.state || '-') + ' / ' + (form.date_of_violation || '-')}</p>
            <p><strong>Files Ready:</strong> {filesCount}</p>
          </div>
          <div className={styles.reviewCard} style={{ marginTop: 14 }}>
            <p style={{ marginTop: 0 }}>
              <strong>Pricing Workflow:</strong>{' '}
              {pricingPreview.loading
                ? 'Checking available attorney pricing...'
                : pricingPreview.available === true
                  ? 'Matching attorney pricing found'
                  : pricingPreview.available === false
                    ? 'Request a quote from our local attorneys'
                    : pricingPreview.message || 'Complete the required fields to preview pricing.'}
            </p>
            {pricingPreview.available === true ? (
              <>
                <p><strong>Attorney Fee:</strong> ${(pricingPreview.attorneyFeeCents / 100).toFixed(2)}</p>
                <p><strong>Platform Fee:</strong> ${(pricingPreview.platformFeeCents / 100).toFixed(2)}</p>
                <p><strong>Total Due:</strong> ${(pricingPreview.totalCents / 100).toFixed(2)}</p>
                {showPricingVisibilityToggle ? (
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 12 }}>
                    <input
                      type="checkbox"
                      checked={form.show_paid_pricing_to_fleet_driver === 'Yes'}
                      onChange={(event) =>
                        updateField('show_paid_pricing_to_fleet_driver', event.target.checked ? 'Yes' : 'No')
                      }
                    />
                    Show paid pricing to Fleet/Driver
                  </label>
                ) : null}
                {showAgencyPrimaryToggle ? (
                  <label style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10 }}>
                    <input
                      type="checkbox"
                      checked={form.keep_agency_as_primary_contact === 'Yes'}
                      onChange={(event) =>
                        updateField('keep_agency_as_primary_contact', event.target.checked ? 'Yes' : 'No')
                      }
                    />
                    Keep Agency as the primary contact
                  </label>
                ) : null}
              </>
            ) : pricingPreview.available === false ? (
              <p style={{ marginBottom: 0 }}>
                Request a quote from our local attorneys. We will contact attorneys who cover this state and county and attorneys within 50
                miles of the court, then notify you as soon as a quote is ready.
              </p>
            ) : (
              <p style={{ marginBottom: 0 }}>{pricingPreview.message || 'Pricing preview will appear here.'}</p>
            )}
          </div>
          <p className={styles.screenHint}>Upload already ran OCR preview for prefills. Submit reuses that preview for the same file when possible, then only runs final OCR for files that still need it.</p>
        </section>

        <footer className={styles.actions}>
          <button type="button" className="button-link secondary" onClick={goBack} disabled={activeStep === 0 || submitting}>
            Back
          </button>
          {activeStep < STEPS.length - 1 ? (
            <button type="button" className="button-link primary" onClick={goNext}>
              Next Step
            </button>
          ) : (
            <button type="submit" className="button-link primary" disabled={submitting}>
              {submitting
                ? 'Submitting...'
                : pricingPreview.available === true
                  ? 'Submit and Continue to Payment'
                  : pricingPreview.available === false
                    ? 'Submit and Request Quote'
                    : 'Submit Intake'}
            </button>
          )}
        </footer>
      </section>
    </form>
  )
}
