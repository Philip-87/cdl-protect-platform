'use client'

import { useEffect } from 'react'
import { usePathname, useRouter } from 'next/navigation'

export default function AuthCallbackBridge() {
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    const hashRaw = window.location.hash.startsWith('#')
      ? window.location.hash.slice(1)
      : window.location.hash
    const hashParams = new URLSearchParams(hashRaw)
    const hasHashAuthToken =
      hashParams.has('access_token') || hashParams.has('refresh_token') || hashParams.has('error')
    const searchParams = new URLSearchParams(window.location.search)
    const hasQueryAuthToken = searchParams.has('code') || searchParams.has('token_hash')

    if (!hasHashAuthToken && !hasQueryAuthToken) return
    if (pathname.startsWith('/auth/confirm')) return

    const target = `/auth/confirm${window.location.search}${window.location.hash}`
    router.replace(target)
  }, [pathname, router])

  return null
}
