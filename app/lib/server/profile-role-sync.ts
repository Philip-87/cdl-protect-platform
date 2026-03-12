'use server'

import type { User } from '@supabase/supabase-js'
import { normalizePlatformRole } from '@/app/lib/roles'
import { createClient } from '@/app/lib/supabase/server'

type SyncResult = {
  applied: boolean
  role: 'DRIVER' | 'FLEET' | 'AGENCY' | 'NONE'
}

function getRequestedRole(user: User): 'DRIVER' | 'FLEET' | 'AGENCY' | 'NONE' {
  const raw = String(user.user_metadata?.requested_role ?? '')
    .trim()
    .toUpperCase()
  if (raw === 'DRIVER') return 'DRIVER'
  if (raw === 'FLEET') return 'FLEET'
  if (raw === 'AGENCY') return 'AGENCY'
  return 'NONE'
}

function getNameParts(user: User) {
  const fullName = String(user.user_metadata?.full_name ?? '').trim()
  if (!fullName) {
    return { firstName: null as string | null, lastName: null as string | null }
  }
  const [first, ...rest] = fullName.split(/\s+/)
  return {
    firstName: first || null,
    lastName: rest.length ? rest.join(' ') : null,
  }
}

export async function syncProfileRoleFromMetadata(user: User): Promise<SyncResult> {
  const requestedRole = getRequestedRole(user)
  if (requestedRole === 'NONE') return { applied: false, role: 'NONE' }

  const supabase = await createClient()
  const profileById = await supabase
    .from('profiles')
    .select('id, user_id, system_role')
    .eq('id', user.id)
    .maybeSingle<{ id: string; user_id: string | null; system_role: string | null }>()

  const profileByUserId =
    profileById.data ||
    (
      await supabase
        .from('profiles')
        .select('id, user_id, system_role')
        .eq('user_id', user.id)
        .maybeSingle<{ id: string; user_id: string | null; system_role: string | null }>()
    ).data

  if (!profileByUserId) {
    const { firstName, lastName } = getNameParts(user)
    const fullName = [firstName, lastName].filter(Boolean).join(' ') || user.email || 'User'
    const insert = await supabase.from('profiles').insert({
      id: user.id,
      user_id: user.id,
      email: user.email ?? null,
      full_name: fullName,
      system_role: requestedRole,
    })
    if (insert.error) {
      return { applied: false, role: requestedRole }
    }
    if (requestedRole === 'DRIVER') {
      await supabase.from('drivers').upsert(
        {
          id: user.id,
          user_id: user.id,
          email: user.email ?? null,
          first_name: firstName,
          last_name: lastName,
        },
        { onConflict: 'user_id' }
      )
    }
    return { applied: true, role: requestedRole }
  }

  const currentRole = normalizePlatformRole(profileByUserId.system_role)
  if (currentRole !== 'NONE') {
    return { applied: false, role: requestedRole }
  }

  const targetFilter = profileByUserId.id === user.id ? { id: user.id } : { user_id: user.id }
  const updateRes = await supabase.from('profiles').update({ system_role: requestedRole }).match(targetFilter)
  if (updateRes.error) {
    return { applied: false, role: requestedRole }
  }

  if (requestedRole === 'DRIVER') {
    const { firstName, lastName } = getNameParts(user)
    await supabase.from('drivers').upsert(
      {
        id: user.id,
        user_id: user.id,
        email: user.email ?? null,
        first_name: firstName,
        last_name: lastName,
      },
      { onConflict: 'user_id' }
    )
  }

  return { applied: true, role: requestedRole }
}
