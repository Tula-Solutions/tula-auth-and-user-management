---
"@tula-tech/contract": minor
"@tula-tech/react": minor
---

A deliberate change of the default theme: Tula's own "ink and paper" replaces the purple one. Warm neutrals (ink `#1a1a18`, paper `#f1efe8`), a primary button that is ink in light and paper in dark, one restrained violet kept for links and the focus ring, 10px and 6px radii, and ink surfaces with paper text in dark. Token names are unchanged and an app that sets `primary` (or any token) keeps its value; only the defaults moved, on web, Swift and Kotlin alike, and every default pair still passes WCAG AA in both schemes. `@tula-tech/react`'s stylesheet is refined (spacing and type rhythm, a crisp focus ring with a soft halo, quiet elevation, entrances and press feedback that stop under `prefers-reduced-motion`, a card that keeps a sensible width from a 320px phone to an ultrawide screen); class names and the public API are unchanged.
