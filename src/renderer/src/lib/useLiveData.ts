import { useEffect } from 'react'

import { useApp } from '../store/app-store'

/**
 * Wires main-process events into the store, and applies the theme tokens that
 * live on the document element.
 *
 * Subscriptions are registered once. The cleanup function returned by `on.*` is
 * respected so a hot reload does not stack duplicate listeners.
 */
export function useLiveData(): void {
  useEffect(() => {
    void useApp.getState().bootstrap()

    const offTick = window.api.on.tick((payload) => {
      useApp.getState().applyTick(payload)
    })

    const offEngine = window.api.on.engineStatus((status) => {
      useApp.getState().setEngine(status)
    })

    const offClipboard = window.api.on.clipboardDetected((detected) => {
      useApp.getState().setClipboardOffer(detected)
    })

    const offToast = window.api.on.toast((payload) => {
      useApp.getState().pushToast(payload)
    })

    const offNavigate = window.api.on.navigate((payload) => {
      useApp.getState().handleNavigation(payload)
    })

    return () => {
      offTick()
      offEngine()
      offClipboard()
      offToast()
      offNavigate()
    }
  }, [])

  const theme = useApp((state) => state.settings?.theme ?? 'dark')
  const accent = useApp((state) => state.settings?.accent ?? 'violet')
  const density = useApp((state) => state.settings?.density ?? 'comfortable')

  // Reflect the theme onto the document element. `system` follows the OS via a
  // media query, which is what a user selecting it means.
  useEffect(() => {
    const root = document.documentElement
    const media = window.matchMedia('(prefers-color-scheme: dark)')

    const apply = (): void => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches)
      root.classList.toggle('dark', dark)
    }

    apply()
    if (theme === 'system') {
      media.addEventListener('change', apply)
      return () => media.removeEventListener('change', apply)
    }
    return undefined
  }, [theme])

  useEffect(() => {
    document.documentElement.setAttribute('data-accent', accent)
  }, [accent])

  useEffect(() => {
    document.documentElement.setAttribute('data-density', density)
  }, [density])
}

/** Re-sync settings when the window regains focus, in case the tray changed them. */
export function useFocusResync(): void {
  useEffect(() => {
    const handler = (): void => {
      if (document.visibilityState !== 'visible') return
      void useApp.getState().refreshSettings()
    }
    window.addEventListener('focus', handler)
    return () => window.removeEventListener('focus', handler)
  }, [])
}
