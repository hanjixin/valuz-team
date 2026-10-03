// Design token source-of-truth. Mirrors the CSS custom properties declared
// in src/styles/project.css (which is what Tailwind v4 actually consumes
// at build time via `@import "tailwindcss"` + `@theme`). This TS export lets
// app code reference the same tokens type-safely.
//
// NOTE: Tailwind v4 drops JS presets in favor of CSS `@theme`. Apps do not
// merge this object into a `tailwind.config.ts`; they import the stylesheet
// from `@valuz/ui` (which re-exports project.css via the package entry).
// This file therefore serves as the canonical token registry for non-CSS
// consumers (charts, inline styles, docs).

export const tokens = {
  color: {
    background: '#f8f9fb',
    foreground: '#131313',
    primary: '#725cf9',
    primaryForeground: '#ffffff',
    mutedForeground: '#6e7481',
    border: '#e6e7e9',
    card: '#ffffff',
    surface: '#ffffff',
    surfaceSoft: '#f7f8fa',
    surfaceMuted: '#f3f4f6',
    brand: '#725cf9',
    brandHover: '#5d46e8',
    brandLight: '#eae6ff',
    success: '#16a34a',
    warning: '#ef8b0c',
    error: '#e5484d',
  },
  font: {
    sans: '"PingFang SC", -apple-system, "Helvetica Neue", sans-serif',
    serif: '"PingFang SC", serif',
    mono: 'ui-monospace, "SF Mono", Menlo, monospace',
  },
  radius: {
    sm: '4px',
    md: '6px',
    lg: '8px',
    xl: '10px',
    '2xl': '12px',
    full: '9999px',
  },
} as const

export type DesignTokens = typeof tokens

export default tokens
