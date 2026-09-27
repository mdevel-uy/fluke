# Fluke — Brand Guide (LLM reference)

## Product
Fluke is a Kanban / task management tool. Origin: Uruguay, South Atlantic coast.

## Name meaning
"Fluke" has two meanings in English, both used intentionally in the brand narrative:
1. A whale's tail fin. Each whale's fluke is unique — researchers identify individuals by their fluke markings, like a fingerprint.
2. A stroke of luck — something that works out unexpectedly, not through skill or planning.

Brand narrative: the product does what a whale fluke does (makes each team's particular shape of work legible at a glance), while positioning itself as the opposite of fluke-as-luck (clarity replaces chance). Example tagline: "Que salga bien no debería ser un fluke" / "Success shouldn't be a fluke."

## Geographic grounding (why Uruguay)
Uruguay's coast is a migration route for the southern right whale. Isla de Lobos, off Punta del Este, hosts one of the largest sea lion and fur seal colonies in the southern hemisphere. The brand draws from this South Atlantic landscape specifically — not a generic tropical/Caribbean marine aesthetic.

## Logo
Only one icon direction has been approved: the **classic fluke silhouette** — a single continuous top-down silhouette of a whale tail, symmetric, no internal cutouts or decoration.

SVG (single color, swap `fill` for light/dark variants):
```svg
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <path d="M50,86 C26,77 6,53 4,21 C3,12 11,10 19,18 C36,36 47,57 50,70 C53,57 64,36 81,18 C89,10 97,12 96,21 C94,53 74,77 50,86 Z" fill="#0B3550"/>
</svg>
```

Color variants in use:
- Dark/ink version: fill `#0B3550`
- Light version (for dark backgrounds): fill `#F3F6F6`
- Alternate "true blue" version (when `#0B3550` reads as near-black at small sizes): fill `#155A8A`

Wordmark: the word "fluke", lowercase, set in Space Grotesk, weight 600, no icon integration — used standalone or paired with the icon in a simple icon-left, text-right lockup with generous spacing between them.

### Usage rules
- Keep clear space around the icon equal to at least the icon's own width.
- Single color only — never gradient, shadow, outline, or multi-color fill.
- Never rotate, skew, or distort the proportions.
- Minimum size: 16px height for icon alone, 20px recommended.
- Ensure AA contrast between icon and background.

## Color palette
| Name | Hex | Role |
|---|---|---|
| Ink | `#0B3550` | Primary. Text, icon, dark backgrounds. |
| Teal | `#3D5A5B` | Secondary. Neutral states, emphasis borders. |
| Amber | `#C7862E` | Single accent. Reserved for CTAs and soft alerts — do not use decoratively. |
| Foam | `#F3F6F6` | Light background. Never pure white. |
| Foam deep | `#E4EAEA` | Panels, subtle dividers on foam background. |

Dark mode background: `#071E2C`, panel `#0C2C3F`, text `#EAF2F3`.

Palette intent: South Atlantic, not Caribbean — no tropical greens, no postcard turquoise.

## Typography
- Display/headings: **Space Grotesk**, weight 600, tight letter-spacing (-0.01em).
- Body: **Inter**, regular/medium weights.
- Line length under 80 characters for body text.
- Avoid: all-caps labels, single-word accent styling in headlines, unnecessary eyebrow labels above content.

## Voice and tone
- **Direct**: short sentences, active voice. "Guardá los cambios," not "Los cambios fueron guardados."
- **No marketing jargon**: describe what the product does, not how well it does it.
- **Located**: default voice is Rioplatense Spanish (voseo — "vos", not "tú"). Do not flatten to neutral/generic Spanish.
- Errors and empty states speak in the interface's voice: explain what happened and what to do next, without apologizing or being vague.

## Status
v0.1, working document. Only the classic fluke icon direction is approved; two other icon concepts (column-cutout version, line-art trace version) were explored and rejected — do not reference or regenerate them as current brand assets.
