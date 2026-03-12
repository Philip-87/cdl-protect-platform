import { NextResponse } from 'next/server'
import { processIntakeSubmission } from '../submit-core'

export async function POST(request: Request) {
  try {
    const formData = await request.formData()
    const destination = await processIntakeSubmission(formData)
    return NextResponse.redirect(new URL(destination, request.url), 303)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected intake error.'
    return NextResponse.redirect(new URL(`/intake?message=${encodeURIComponent(message)}`, request.url), 303)
  }
}
