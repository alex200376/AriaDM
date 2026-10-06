/**
 * Vite's client types, so asset imports are typed.
 *
 * The renderer bundles the one image it draws — the app mark in the title bar —
 * and without this an `import ... from './mark.png'` is a type error rather than a
 * string URL. Everything else the renderer shows is either text or an icon from
 * `lucide-react`, which needs no declaration of its own.
 */
/// <reference types="vite/client" />
