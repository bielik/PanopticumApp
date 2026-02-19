# Panopticum UI Guide

## Design Philosophy

Minimal, corporate-calm. Inspired by Severance's Lumon Industries aesthetic but evolved beyond the CRT terminal look into a clean, modern interpretation. Few elements, generous whitespace, restrained palette. Every page should feel eerily calm and controlled.

**Core rules:**
- Two typefaces only, max 2 font sizes per page
- Max 3 colors per page (background + text + accent)
- Outlined boxes, not filled cards. Sharp corners (2-4px max radius)
- Generous spacing. Let elements breathe.

## Color System

### CSS Custom Properties (`:root`)

| Token | Hex | Role |
|-------|-----|------|
| `--lumon-dark` | `#161E26` | Darkest surfaces, video container bg, controller page bg, cursor |
| `--lumon-green-deep` | `#213525` | Accent on light backgrounds — input text, borders, button text |
| `--lumon-green` | `#8DB07A` | Primary interactive on dark backgrounds — active states, indicators, labels |
| `--lumon-light` | `#E4E7E5` | Text on dark backgrounds, light surface fills |
| `--lumon-sage` | `#7a9a86` | Primary background — idle screen, lobby, public-facing pages |
| `--lumon-glow` | `rgba(141, 176, 122, 0.4)` | Glow/box-shadow for green elements |

### Usage Rules

- **All colors via CSS variables** — no hardcoded hex values in style.css
- **On sage background** (`--lumon-sage`): white (`#fff`) text + `--lumon-green-deep` accents
- **On dark background** (`--lumon-dark`): `--lumon-light` for primary text, `--lumon-green` for labels/active states
- White (`#fff`) is used directly for text on sage backgrounds — it is not a token

### Color Pairing Quick Reference

| Background | Primary text | Accent / Interactive | Borders |
|------------|-------------|---------------------|---------|
| `--lumon-sage` | `#fff` | `--lumon-green-deep` | `--lumon-green-deep` |
| `--lumon-dark` | `--lumon-light` | `--lumon-green` | `--lumon-green-deep` |

## Typography

### Typefaces

| Font | Role | Weights |
|------|------|---------|
| **Inter** | Headings only | 700 |
| **Share Tech Mono** | Everything else — data, inputs, buttons, labels, status text | 400 |

Google Fonts import:
```css
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@700&family=Share+Tech+Mono&display=swap');
```

**No other typefaces.** DM Serif Display is used only for the Insta video overlay effect (artistic exception, not UI).

### Size Scale

Only 2 sizes per page:

| Name | Value | Used for |
|------|-------|----------|
| **Display** | `clamp(3.5rem, 7vw, 5.5rem)` | Hero heading (one per page) |
| **Body** | `0.85rem` | All other text — unified single size |

### Text Styling

| Element | Font | Weight | Size | Case | Letter-spacing |
|---------|------|--------|------|------|---------------|
| Page heading | Inter | 700 | Display | Sentence case | 2px |
| Clock / data | Share Tech Mono | 400 | Body | Normal | 3px |
| Input text | Share Tech Mono | 400 | Body | Normal | 2px |
| Placeholder | Share Tech Mono | 400 | Body | Uppercase | 2px |
| Button label | Share Tech Mono | 400 | Body | Uppercase | 2px |
| Status text | Share Tech Mono | 400 | Body | Uppercase | 3px |
| Labels | Share Tech Mono | 400 | Body | Uppercase | 2px |

## Components

### Buttons

```
Default:  transparent bg, 1px solid var(--lumon-green-deep), color var(--lumon-green-deep)
Hover:    var(--lumon-green-deep) bg, color #fff
Active:   same as hover
Disabled: opacity 0.4, cursor not-allowed
```

- Font: Share Tech Mono, 0.85rem, uppercase, letter-spacing 2px
- Padding: `10px 24px`
- No border-radius (or 2px max)

### Text Inputs

- **Bottom border only**: `1px solid var(--lumon-green-deep)`, all other borders transparent
- Background: transparent
- Text color: `var(--lumon-green-deep)`
- Placeholder: `var(--lumon-green-deep)` at `opacity: 0.6`, uppercase
- Focus: same border color (no color shift)
- Font: Share Tech Mono, 0.85rem, centered text, letter-spacing 2px

### Custom Cursor

Applied to interactive screens (idle, lobby). Hidden during video playback.

```css
/* Outline circle */
cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='10' fill='none' stroke='%23161E26' stroke-width='2'/%3E%3C/svg%3E") 12 12, auto;

/* Filled on click (:active) */
cursor: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E%3Ccircle cx='12' cy='12' r='10' fill='%23161E26' stroke='%23161E26' stroke-width='2'/%3E%3C/svg%3E") 12 12, auto;
```

### Vignette Overlay

Applied via `::after` pseudo-element on page containers:

```css
background: radial-gradient(ellipse at center, transparent 30%, rgba(0, 0, 0, 0.4) 100%);
pointer-events: none;
z-index: 2;
```

### Logo (Panopticum SVG)

- Fill: `#fff`
- Glow: `drop-shadow(0 0 12px rgba(255,255,255,0.5)) drop-shadow(0 0 30px rgba(255,255,255,0.2))`
- Width: 120-160px
- Placement: bottom of page, centered

### Typewriter Animation

For status/loading text:

```css
overflow: hidden;
white-space: nowrap;
width: fit-content;
max-width: 0;
animation: idle-typewriter 2.5s steps(N) 0.5s forwards,
           idle-cursor-blink 0.6s step-end infinite;
border-right: 2px solid rgba(255, 255, 255, 0.7);
```

Where `N` = character count of the text.

### WebGL Ripple Effect

Worker idle screen only. Uses `jquery.ripples.js` (MIT, requires jQuery).

```javascript
// Background must be passed as image (plugin can't use CSS bg color)
var c = document.createElement('canvas');
c.width = 1; c.height = 1;
var ctx = c.getContext('2d');
ctx.fillStyle = '#7a9a86';
ctx.fillRect(0, 0, 1, 1);

$('#element').ripples({
    resolution: 512,
    dropRadius: 20,
    perturbance: 0.04,
    interactive: true,
    imageUrl: c.toDataURL()
});
```

## Page Templates

### Worker Idle Screen

| Property | Value |
|----------|-------|
| Background | `var(--lumon-sage)` |
| Layout | flex column, align center, justify center |
| Overlay | Vignette (::after) |
| Effect | WebGL ripple |
| Cursor | Custom circle |

Element stack (top to bottom):
1. Heading — Inter 700, Display size, white, sentence case
2. Clock — Share Tech Mono, Body size, white
3. Input + Button row — Share Tech Mono, Body size, `--lumon-green-deep`
4. Status text — Share Tech Mono, Body size, white, typewriter animation
5. Logo — SVG, white with glow, 160px

### Lobby Page

| Property | Value |
|----------|-------|
| Background | `var(--lumon-sage)` |
| Layout | centered card, flex column |
| Card | transparent bg, 1px `--lumon-green-deep` border |
| Cursor | Custom circle |
| Overlay | Vignette |

### Controller Page

| Property | Value |
|----------|-------|
| Background | `var(--lumon-dark)` |
| Panels | 1px `--lumon-green-deep` border, transparent fill |
| Text | `--lumon-light` primary, `--lumon-green` for labels/active |
| Buttons | Outlined `--lumon-green` border, fill on hover |
| No custom cursor | Standard cursor for precision controls |

## Responsive Breakpoints

| Width | Effect |
|-------|--------|
| 1200px | Panels shrink, reduce padding |
| 1000px | Controls stack vertically |
| 850px | Single column, video 16:9, log below |
| 480px | Compact mobile, forms stack |

Heading sizes use `clamp()` for fluid scaling across all breakpoints.

## Video Overlay Effects (Artistic Exceptions)

These are artistic effects applied during video playback. They intentionally break the UI color rules:

| Effect | Colors | Font |
|--------|--------|------|
| CCTV | `#00ff41` neon green, `#ff0000` red (REC) | Share Tech Mono |
| Insta | Warm sepia `rgba(245, 225, 195, 0.45)`, white text | DM Serif Display |

These overlays are only visible on the video feed, never on UI chrome.
