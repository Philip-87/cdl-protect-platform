'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { syncAttorneyMatchingCoverageForProfile } from '@/app/lib/matching/attorneyCoverageSync'
import { isAttorneyRole, isStaffRole, normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'

type CountyFeeInput = {
  county: string
  cdlFee: number
  nonCdlFee: number
}

type PaymentDetailsInput = {
  achBankName: string
  achAccountNumber: string
  achRoutingNumber: string
  zelleContact: string
  lawpayAccount: string
  stripeAccount: string
  paypalContact: string
  otherDetails: string
}

const SUPPORTED_PAYMENT_METHODS = new Set(['ACH', 'LawPay', 'Zelle', 'Stripe', 'PayPal', 'Other'])

function parseString(value: FormDataEntryValue | null) {
  return String(value ?? '').trim()
}

function parseNumber(value: FormDataEntryValue | null) {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : null
}

function parseJsonArray(raw: string) {
  if (!raw) return [] as string[]
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []
    return value.map((item) => String(item).trim()).filter(Boolean)
  } catch {
    return []
  }
}

function parseCountyFees(raw: string) {
  if (!raw) return [] as CountyFeeInput[]
  try {
    const value = JSON.parse(raw)
    if (!Array.isArray(value)) return []

    return value
      .map((item) => ({
        county: String(item?.county ?? '').trim(),
        cdlFee: Number(item?.cdlFee),
        nonCdlFee: Number(item?.nonCdlFee),
      }))
      .filter(
        (item) =>
          item.county &&
          Number.isFinite(item.cdlFee) &&
          Number.isFinite(item.nonCdlFee) &&
          item.cdlFee > 0 &&
          item.nonCdlFee > 0
      )
  } catch {
    return []
  }
}

function parsePaymentDetails(raw: string): PaymentDetailsInput {
  if (!raw) {
    return {
      achBankName: '',
      achAccountNumber: '',
      achRoutingNumber: '',
      zelleContact: '',
      lawpayAccount: '',
      stripeAccount: '',
      paypalContact: '',
      otherDetails: '',
    }
  }

  try {
    const value = JSON.parse(raw) as Partial<PaymentDetailsInput>
    return {
      achBankName: String(value?.achBankName ?? '').trim(),
      achAccountNumber: String(value?.achAccountNumber ?? '').trim(),
      achRoutingNumber: String(value?.achRoutingNumber ?? '').trim(),
      zelleContact: String(value?.zelleContact ?? '').trim(),
      lawpayAccount: String(value?.lawpayAccount ?? '').trim(),
      stripeAccount: String(value?.stripeAccount ?? '').trim(),
      paypalContact: String(value?.paypalContact ?? '').trim(),
      otherDetails: String(value?.otherDetails ?? '').trim(),
    }
  } catch {
    return {
      achBankName: '',
      achAccountNumber: '',
      achRoutingNumber: '',
      zelleContact: '',
      lawpayAccount: '',
      stripeAccount: '',
      paypalContact: '',
      otherDetails: '',
    }
  }
}

function digitsOnly(value: string) {
  return value.replace(/\D+/g, '')
}

function buildPaymentIdentifier(
  paymentMethods: string[],
  paymentDetails: PaymentDetailsInput,
  fallback: string
) {
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

async function getAttorneyContext() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect('/attorney/login?message=Please%20sign%20in.')
  }

  const profileById = await supabase
    .from('profiles')
    .select('system_role')
    .eq('id', user.id)
    .maybeSingle<{ system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ system_role: string | null }>()
    ).data

  const role = normalizePlatformRole(profileByUserId?.system_role)
  if (!isAttorneyRole(role) && !isStaffRole(role)) {
    redirect('/dashboard?message=Attorney%20onboarding%20requires%20an%20attorney%20or%20admin%20role.')
  }

  return { supabase, user, role }
}

export async function saveAttorneyOnboardingStepTwo(formData: FormData) {
  const { supabase, user } = await getAttorneyContext()

  const fullName = parseString(formData.get('full_name'))
  const email = parseString(formData.get('email')).toLowerCase()
  const phone = parseString(formData.get('phone'))
  const state = parseString(formData.get('state')).toUpperCase()
  const officeAddress = parseString(formData.get('office_address'))
  const city = parseString(formData.get('city'))
  const zipCode = parseString(formData.get('zip_code'))
  const paymentMethods = parseJsonArray(parseString(formData.get('payment_methods_json'))).filter((method) =>
    SUPPORTED_PAYMENT_METHODS.has(method)
  )
  const paymentIdentifierInput = parseString(formData.get('payment_identifier'))
  const paymentDetails = parsePaymentDetails(parseString(formData.get('payment_details_json')))
  const otherPayment = parseString(formData.get('other_payment'))
  const feeMode = parseString(formData.get('fee_mode')).toUpperCase() === 'BY_COUNTY' ? 'BY_COUNTY' : 'GLOBAL'
  const cdlFlatFee = parseNumber(formData.get('cdl_flat_fee'))
  const nonCdlFlatFee = parseNumber(formData.get('non_cdl_flat_fee'))
  const counties = parseJsonArray(parseString(formData.get('counties_json')))
  const countyFees = parseCountyFees(parseString(formData.get('county_fees_json')))

  if (!fullName || !email || !phone || !state || !officeAddress || !zipCode) {
    redirect('/attorney/onboarding?message=Complete%20all%20required%20profile%20fields.')
  }

  if (!paymentMethods.length) {
    redirect('/attorney/onboarding?message=Select%20at%20least%20one%20payment%20method.')
  }

  if (paymentMethods.includes('ACH')) {
    const routingDigits = digitsOnly(paymentDetails.achRoutingNumber)
    const accountDigits = digitsOnly(paymentDetails.achAccountNumber)
    if (!paymentDetails.achBankName || routingDigits.length !== 9 || accountDigits.length < 4) {
      redirect(
        '/attorney/onboarding?message=ACH%20requires%20bank%20name%2C%209-digit%20routing%20number%2C%20and%20account%20number.'
      )
    }
  }

  if (paymentMethods.includes('Zelle') && !paymentDetails.zelleContact) {
    redirect('/attorney/onboarding?message=Zelle%20requires%20email%20or%20phone%20identifier.')
  }

  if (paymentMethods.includes('LawPay') && !paymentDetails.lawpayAccount) {
    redirect('/attorney/onboarding?message=LawPay%20requires%20a%20merchant%20identifier.')
  }

  if (paymentMethods.includes('Stripe') && !paymentDetails.stripeAccount) {
    redirect('/attorney/onboarding?message=Stripe%20requires%20an%20account%20identifier.')
  }

  if (paymentMethods.includes('PayPal') && !paymentDetails.paypalContact) {
    redirect('/attorney/onboarding?message=PayPal%20requires%20an%20email%20or%20merchant%20identifier.')
  }

  if (paymentMethods.includes('Other') && !paymentDetails.otherDetails && !otherPayment) {
    redirect('/attorney/onboarding?message=Other%20payment%20method%20requires%20details.')
  }

  const paymentIdentifier = buildPaymentIdentifier(paymentMethods, paymentDetails, paymentIdentifierInput)
  if (!paymentIdentifier) {
    redirect('/attorney/onboarding?message=Select%20payment%20method%20and%20identifier.')
  }

  if (!counties.length) {
    redirect('/attorney/onboarding?message=Select%20at%20least%20one%20county.')
  }

  if (feeMode === 'GLOBAL') {
    if (!(cdlFlatFee && cdlFlatFee > 0) || !(nonCdlFlatFee && nonCdlFlatFee > 0)) {
      redirect('/attorney/onboarding?message=Global%20fees%20must%20be%20positive%20numbers.')
    }
  } else if (!countyFees.length) {
    redirect('/attorney/onboarding?message=Enter%20county-level%20fees%20for%20selected%20counties.')
  }

  const membership = await supabase
    .from('attorney_firm_memberships')
    .select('firm_id')
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle<{ firm_id: string }>()

  const firmId = membership.data?.firm_id ?? null

  const payload = {
    user_id: user.id,
    firm_id: firmId,
    full_name: fullName,
    email,
    phone,
    state,
    office_address: officeAddress,
    city: city || null,
    zip_code: zipCode,
    payment_methods: paymentMethods,
    payment_identifier: paymentIdentifier,
    other_payment: paymentDetails.otherDetails || otherPayment || null,
    fee_mode: feeMode,
    cdl_flat_fee: feeMode === 'GLOBAL' ? cdlFlatFee : null,
    non_cdl_flat_fee: feeMode === 'GLOBAL' ? nonCdlFlatFee : null,
    coverage_states: [state],
    primary_county: counties[0] || null,
    counties: counties,
    metadata: {
      payment_methods: paymentMethods,
      payment_details: paymentDetails,
      payment_identifier: paymentIdentifier,
      county_count: counties.length,
      coverage_states: [state],
    },
  }

  const upsert = await supabase
    .from('attorney_onboarding_profiles')
    .upsert(payload, { onConflict: 'user_id' })
    .select('id')
    .single<{ id: string }>()

  if (upsert.error) {
    redirect(`/attorney/onboarding?message=${encodeURIComponent(upsert.error.message)}`)
  }

  const profileId = upsert.data.id
  await supabase.from('attorney_county_fees').delete().eq('attorney_profile_id', profileId)

  if (feeMode === 'BY_COUNTY' && countyFees.length) {
    const countyRows = countyFees.map((item) => ({
      attorney_profile_id: profileId,
      state,
      county_name: item.county,
      cdl_fee: item.cdlFee,
      non_cdl_fee: item.nonCdlFee,
    }))

    const countyInsert = await supabase.from('attorney_county_fees').insert(countyRows)
    if (countyInsert.error) {
      redirect(`/attorney/onboarding?message=${encodeURIComponent(countyInsert.error.message)}`)
    }
  }

  if (firmId) {
    await supabase
      .from('attorney_firms')
      .update({
        contact_name: fullName,
        email,
        phone,
        state,
        coverage_states: [state],
        primary_county: counties[0] || null,
        counties,
        office_address: officeAddress,
        city: city || null,
        zip_code: zipCode,
        coverage_notes:
          feeMode === 'GLOBAL'
            ? `Global fees - CDL: ${cdlFlatFee}, Non-CDL: ${nonCdlFlatFee}`
            : `County-based fee matrix (${countyFees.length} counties)`,
      })
      .eq('id', firmId)
  }

  try {
    await syncAttorneyMatchingCoverageForProfile(profileId)
  } catch (error) {
    console.error('Attorney onboarding matching sync failed:', error)
  }

  revalidatePath('/attorney/onboarding')
  revalidatePath('/attorney/dashboard')
  redirect('/attorney/onboarding?step=3&message=Profile%20saved.%20Please%20sign%20the%20agreement.')
}

export async function finishAttorneyOnboarding(formData: FormData) {
  const { supabase, user } = await getAttorneyContext()

  const signatureText = parseString(formData.get('signature_text'))
  const termsVersion = parseString(formData.get('terms_version')) || '2026-02-29'
  const agreed = parseString(formData.get('agreed_to_terms')) === 'true'

  if (!agreed || !signatureText) {
    redirect('/attorney/onboarding?step=3&message=You%20must%20agree%20to%20terms%20and%20sign.')
  }

  const update = await supabase
    .from('attorney_onboarding_profiles')
    .update({
      agreed_to_terms: true,
      terms_version: termsVersion,
      signature_text: signatureText,
      signed_at: new Date().toISOString(),
    })
    .eq('user_id', user.id)

  if (update.error) {
    redirect(`/attorney/onboarding?step=3&message=${encodeURIComponent(update.error.message)}`)
  }

  revalidatePath('/attorney/onboarding')
  revalidatePath('/attorney/dashboard')
  redirect('/attorney/dashboard?message=Onboarding%20completed.%20Welcome%20to%20your%20attorney%20portal.')
}
