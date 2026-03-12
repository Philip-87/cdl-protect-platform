'use client'

import { useState } from 'react'

type ThemeMode = 'light' | 'dark'

function getSystemTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light'
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light'
  const stored = window.localStorage.getItem('cdl-theme')
  if (stored === 'dark' || stored === 'light') return stored
  return getSystemTheme()
}

function applyTheme(mode: ThemeMode) {
  if (typeof document === 'undefined') return
  document.documentElement.setAttribute('data-theme', mode)
}

export default function ThemeToggle() {
  const [theme, setTheme] = useState<ThemeMode>(() => {
    if (typeof document !== 'undefined') {
      const domTheme = document.documentElement.getAttribute('data-theme')
      if (domTheme === 'dark' || domTheme === 'light') return domTheme
    }
    return getStoredTheme()
  })

  return (
    <button
      type="button"
      className="theme-toggle"
      aria-label="Toggle dark mode"
      onClick={() => {
        const next: ThemeMode = theme === 'dark' ? 'light' : 'dark'
        setTheme(next)
        applyTheme(next)
        window.localStorage.setItem('cdl-theme', next)
      }}
    >
      {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
    </button>
  )
}
