'use server'

import { redirect } from 'next/navigation'
import { processIntakeSubmission } from './submit-core'

export async function submitIntake(formData: FormData) {
  const destination = await processIntakeSubmission(formData)
  redirect(destination)
}
