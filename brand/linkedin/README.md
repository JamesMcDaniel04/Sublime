# Sublime — LinkedIn company page logo

Generated from the canonical mark in
[`src/components/landing/stacked-logo.tsx`](../../src/components/landing/stacked-logo.tsx)
(three staggered rects, 16-unit viewBox) using the brand dark-theme tokens from
[`src/app/globals.css`](../../src/app/globals.css):

| Token | Value | Hex |
| --- | --- | --- |
| `--background` (dark) | `240 6% 6%` | `#0E0E10` |
| `--foreground` (dark) | `0 0% 90%` | `#E5E5E5` |

> **Heads up:** the logo files in `public/` (`sublime-icon-hq.svg`,
> `sublime-logo-white.svg`, `sublime-lockup-black.svg`) are **stale** — a
> navy/coral ribbon icon and a Georgia serif wordmark from an earlier identity.
> They do not match the shipped brand. `stacked-logo.tsx` is the real mark.

## Upload this one

**`sublime-linkedin-400.png`** — 400×400, dark field, mark only.

LinkedIn requires 300×300 minimum but renders the logo at 72px on the page
header and as small as 24px inline, so the wordmark is deliberately omitted —
at 48px a horizontal "≡ SUBLIME" lockup gives the type a ~3px cap height. See
`_preview-render-sizes.png` for every real render size on light and dark UI.

## Files

| File | Size | Use |
| --- | --- | --- |
| `sublime-linkedin-400.png` | 400×400 | **Company page logo — upload this** |
| `sublime-linkedin-1000.png` | 1000×1000 | Hi-res master |
| `sublime-linkedin-300.png` | 300×300 | LinkedIn's stated minimum |
| `sublime-linkedin-light-400.png` | 400×400 | Light/inverted alt (`#0A0A0A` on white) |
| `sublime-linkedin-light-1000.png` | 1000×1000 | Light master |
| `sublime-linkedin-stacked-400.png` | 400×400 | Mark + wordmark — **not recommended** for the avatar |
| `sublime-linkedin-stacked-1000.png` | 1000×1000 | Stacked master |
| `sublime-linkedin-dark.svg` / `-light.svg` | vector | Regeneration source |
| `_preview-render-sizes.png` | — | Contact sheet at LinkedIn's render sizes |

## Construction notes

- The mark is **not** centered inside its own 16×16 viewBox — its true bounding
  box is x `2→14.5`, y `1.5→15`. Scaling the raw SVG leaves it visibly
  off-axis, so these are centered on the bounding box, verified to 0px delta.
- Glyph height is 58% of the canvas. Its corner-to-corner diagonal (791px at
  1000×1000) stays inside the inscribed circle, so it survives a circular crop.
- **Full-bleed, no baked-in corner radius.** LinkedIn applies its own ~18%
  rounded-square mask; pre-rounding would show dark corner slivers.
- The x-offsets (3, 4.5, 2) are the brand's intentional stagger and are
  preserved exactly — bar widths are pixel-identical across all three.
- Wordmark (stacked variant only) is Geist Bold, `letter-spacing: 0.08em`,
  uppercase, matching the nav lockup in `landing-page.tsx:88`.
