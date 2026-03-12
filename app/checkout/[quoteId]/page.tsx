import { redirect } from 'next/navigation'
import { createClient } from '@/app/lib/supabase/server'
import { getLawPayPublicAccountId } from '@/app/lib/server/lawpay'
import CheckoutClient from './CheckoutClient'

export default async function CheckoutPage({ params }: { params: Promise<{ quoteId: string }> }) {
  const { quoteId } = await params
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?redirectedFrom=${encodeURIComponent(`/checkout/${quoteId}`)}`)
  }

  const quoteRes = await supabase
    .from('case_quotes')
    .select('id, case_id, attorney_fee_cents, platform_fee_cents, total_cents, status, quote_source')
    .eq('id', quoteId)
    .maybeSingle<{
      id: string
      case_id: string
      attorney_fee_cents: number
      platform_fee_cents: number
      total_cents: number
      status: string
      quote_source?: string | null
    }>()

  if (quoteRes.error || !quoteRes.data) {
    return (
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
        <p>Quote not found or you do not have access.</p>
      </main>
    )
  }

  if (String(quoteRes.data.status).toUpperCase() === 'PAID') {
    return (
      <main style={{ maxWidth: 900, margin: '40px auto', padding: '0 16px' }}>
        <p>This quote has already been paid.</p>
      </main>
    )
  }

  const [caseRes, paymentRequestRes] = await Promise.all([
    supabase
      .from('cases')
      .select('id, citation_number, payment_flow_status, primary_contact_type')
      .eq('id', quoteRes.data.case_id)
      .maybeSingle<{
        id: string
        citation_number: string | null
        payment_flow_status: string | null
        primary_contact_type: string | null
      }>(),
    supabase
      .from('payment_requests')
      .select('status, source_type, due_at')
      .eq('quote_id', quoteId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle<{
        status: string
        source_type: string | null
        due_at: string | null
      }>(),
  ])

  const caseReference = caseRes.data?.citation_number || quoteRes.data.case_id

  return (
    <main style={{ maxWidth: 900, margin: '32px auto', padding: '0 16px' }}>
      <h1>Case Checkout</h1>
      <p style={{ color: '#586079' }}>
        Case reference: <strong>{caseReference}</strong>
      </p>
      <CheckoutClient
        quoteId={quoteRes.data.id}
        caseId={quoteRes.data.case_id}
        caseReference={caseReference}
        totalCents={quoteRes.data.total_cents}
        attorneyFeeCents={quoteRes.data.attorney_fee_cents}
        platformFeeCents={quoteRes.data.platform_fee_cents}
        paymentFlowStatus={caseRes.data?.payment_flow_status ?? null}
        primaryContactType={caseRes.data?.primary_contact_type ?? null}
        paymentRequestStatus={paymentRequestRes.data?.status ?? null}
        paymentRequestSourceType={paymentRequestRes.data?.source_type ?? null}
        paymentDueAt={paymentRequestRes.data?.due_at ?? null}
        quoteSource={quoteRes.data.quote_source ?? null}
        lawPayAccountId={getLawPayPublicAccountId()}
      />
    </main>
  )
}
