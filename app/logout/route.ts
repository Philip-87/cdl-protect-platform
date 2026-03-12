import { NextResponse } from 'next/server'
import { createClient } from '@/app/lib/supabase/server'

export async function GET(request: Request) {
  const supabase = await createClient()
  await supabase.auth.signOut()

  const url = new URL('/login', request.url)
  return NextResponse.redirect(url)
}
