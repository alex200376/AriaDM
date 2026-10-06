import { useEffect } from 'react'

import { useApp } from '../store/app-store'
import { applyAppearance } from './appearance'

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

  const settings = useApp((state) => state.settings)
  const wallpaper = useApp((state) => state.wallpaper)

  // One effect for the whole look: theme, accent (including a custom colour),
  // density and the wallpaper all live on the same element, so applying them
  // together means a change can never land half-way. `system` follows the OS via
  // a media query, which is what a user selecting it means.
  useEffect(() => {
    if (!settings) return undefined
    return applyAppearance(document.documentElement, {
      theme: settings.theme,
      accent: settings.accent,
      customAccent: settings.customAccent,
      density: settings.density,
      wallpaper,
      blur: settings.backgroundBlur,
      dim: settings.backgroundDim,
      opacity: settings.backgroundOpacity
    })
  }, [settings, wallpaper])
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
