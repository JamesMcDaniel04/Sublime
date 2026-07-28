# Sublime brand assets

All marks derive from
[`src/components/landing/stacked-logo.tsx`](../src/components/landing/stacked-logo.tsx)
— three staggered rounded rects, 16-unit viewBox — using the `.dark` tokens in
[`src/app/globals.css`](../src/app/globals.css): background `#0E0E10`
(`240 6% 6%`), foreground `#E5E5E5` (`0 0% 90%`).

The glyph's true bounding box is x `2→14.5`, y `1.5→15` — it is **not** centred
in its own viewBox. Centre on the bounding box, or it sits visibly off-axis.

- [`linkedin/`](linkedin/) — LinkedIn company page logo. See its README.

## Site icons

Live in the app, not this folder:

| File | Ratio | Notes |
| --- | --- | --- |
| `src/app/icon.svg` | 78% | Favicon. Browsers prefer it; stays crisp on hi-dpi. |
| `src/app/icon.png` | 78% | 512×512 favicon fallback. |
| `src/app/apple-icon.png` | 60% | 180×180. iOS masks ~22% corners, so more inset. |
| `public/sublime-icon.png` | 72% | Sidebar org chip (32px) + integration row (24px). |

"Ratio" is glyph height as a fraction of the tile.

**Why 78% for the favicon.** The binding constraint at a 16px tab render is the
1.5u gap between bars, which is 11.1% of glyph height. Measured brightness of
the gap pixel at 16px (background `#0E0E10` = greyscale 14):

| ratio | 16px profile | gap value |
| --- | --- | --- |
| 70% | `..+##++##++##+..` | 85 — washes out, reads as one striped block |
| 74% | `..###.+##+.###..` | 43 |
| **78%** | `.+###.+##+.###+.` | **15 — resolves to background** |
| 84% (native) | `.####.####.####.` | 15, but zero padding |

78% is the smallest ratio where the bars fully separate at 16px while keeping
breathing room in the tile.

**Why a filled tile rather than a transparent mark.** The two in-app render
contexts disagree: the sidebar org chip applies `bg-white p-0.5`
([sidebar.tsx:488](../src/components/layout/sidebar.tsx#L488)) while
`IntegrationLogo` renders on a bare box
([integration-logo.tsx:128](../src/components/integrations/integration-logo.tsx#L128)),
where a dark transparent mark would disappear in dark mode. A self-contained
dark tile is the only asset that works in both.

**No baked-in corner radius.** LinkedIn and iOS apply their own masks;
pre-rounding shows dark corner slivers. Browser tabs draw favicons unmasked.

## Stale assets

These are a prior identity (navy/coral "folded ribbon S" + a Georgia serif
wordmark) and have **zero code references**. They do not match the shipped
brand and are safe to delete:

    public/sublime-icon-2048.png     174 KB
    public/sublime-icon-hq.svg
    public/sublime-logo-small.png     59 KB
    public/sublime-logo-white.svg
    public/sublime-lockup-black.svg
