# Betty Landing Page — Project Spec

Use this document to scaffold a standalone repo (e.g. `betty-website`) with a single-page marketing/download site for the Bethaniel desktop app.

---

## 1. Purpose

A minimal, elegant landing page where authors can:

- Learn what Betty does in 10 seconds
- Download the latest installer for macOS, Windows, or Linux
- See key features at a glance

No sign-up, no payment, no tracking. Free download.

---

## 2. Visual Style (match the app)

| Token           | Value                                                                    | Usage                  |
| --------------- | ------------------------------------------------------------------------ | ---------------------- |
| `--bg`          | `#f7f1e3`                                                                | Page background        |
| `--bg-gradient` | `radial-gradient(ellipse at top, #faf5e6 0%, #f7f1e3 60%, #f0e8d4 100%)` | Subtle warmth          |
| `--surface`     | `#efe6d0`                                                                | Cards / sections       |
| `--border`      | `#c9b896`                                                                | Dividers, card borders |
| `--text`        | `#2a2419`                                                                | Body text              |
| `--heading`     | `#1a140a`                                                                | Headings               |
| `--muted`       | `#8b7355`                                                                | Captions, labels       |
| `--accent`      | `#1a140a`                                                                | Buttons (dark ink)     |
| `--accent-text` | `#f7f1e3`                                                                | Text on accent buttons |

### Fonts

- **Headings:** "Cormorant Garamond", Georgia, serif — weight 600
- **Body:** "Inter", -apple-system, system-ui, sans-serif

Load from Google Fonts:

```
Cormorant+Garamond:wght@400;600;700
Inter:wght@400;500;600
```

### General feel

Warm parchment tones. Bookish. Quiet confidence. No flashy gradients or neon. Think: the inside cover of a well-made novel.

---

## 3. Page Structure

### Hero

```
[Betty logo/wordmark]

Your private copy editor.

Betty is a free, fully offline AI copy editor for manuscripts.
No cloud. No subscription. Your words never leave your machine.

[Download for macOS]  [Download for Windows]  [Download for Linux]
```

### Features (3-column grid on desktop, stacked on mobile)

| Icon idea | Heading            | Copy                                                                                                    |
| --------- | ------------------ | ------------------------------------------------------------------------------------------------------- |
| 🔒        | Completely Private | Runs 100% locally. No internet required. Your manuscript stays on your computer — always.               |
| 📖        | Built for Authors  | Understands chapters, style guides, and character names. Edits like a human copy editor, not a chatbot. |
| ⚡        | One-Click Setup    | Download, open, pick a model. Betty handles the rest — no terminal, no configuration, no fuss.          |

### How It Works (brief)

```
1. Drop in your manuscript (.docx or .epub)
2. Betty splits it into chapters and queues edits
3. Review changes with tracked diffs — accept or reject each one
4. Export your polished manuscript
```

### System Requirements (small table or list)

- macOS 12+ (Apple Silicon or Intel)
- Windows 10+ (64-bit)
- Linux (x64, glibc 2.31+)
- 8 GB RAM minimum (16 GB recommended)
- ~3 GB disk for the bundled model

### Footer

```
Betty is free and open source.
Built with care for writers who value their privacy.
```

---

## 4. Tech Stack (keep it simple)

- **Static site** — HTML + CSS + minimal JS (no framework needed)
- Host on GitHub Pages, Netlify, or Vercel (zero cost)
- Single `index.html` + `style.css` + assets folder
- Alternatively: Astro or Eleventy if you want markdown content pages later

---

## 5. Download Links

Point download buttons to GitHub Releases:

```
https://github.com/<owner>/bethaniel/releases/latest/download/Bethaniel-{version}-arm64.dmg
https://github.com/<owner>/bethaniel/releases/latest/download/Bethaniel-{version}-x64.exe
https://github.com/<owner>/bethaniel/releases/latest/download/Bethaniel-{version}-x86_64.AppImage
```

Use a small JS snippet or GitHub API to resolve `latest` and fill in the version dynamically. Fallback: link to the releases page.

---

## 6. Copy / Tone

Betty's voice is **fun, casual, and a little cheeky** — like a sharp friend who happens to be great at grammar. Not corporate. Not robotic. She talks _to_ you, not _at_ you.

**In-app examples to match:**

- "But you can call me Betty" (subtitle)
- "How can I help you?" (section heading)
- "Let's have a look at your content" (section heading)
- "Choose your Betty" (model picker)
- "Business in the front — party in the back." (Business Betty description)

**Guidelines:**

- First person where it feels natural ("I'll handle the rest")
- Speak directly to fiction authors and non-technical writers
- No jargon — never say "LLM", "inference", "API", or "model weights"
- Use "Betty" as the friendly name everywhere on the site
- Short sentences. Let whitespace breathe.
- Warm and confident, but never precious or self-important
- OK to be playful — a dash of humour is on-brand
- Think: the cool copy editor at a publishing house, not a Silicon Valley product page

---

## 7. Assets Needed

- Betty logo (SVG) — reuse from the app's sidebar logo
- Screenshot or stylized mockup of the editor UI (optional but nice)
- Open Graph image (1200×630) for social sharing

---

## 8. Repo Structure

```
betty-website/
├── index.html
├── style.css
├── assets/
│   ├── logo.svg
│   ├── og-image.png
│   └── screenshot.png (optional)
├── CNAME (if using custom domain)
└── README.md
```

---

## 9. Nice-to-Haves (later)

- Dark mode toggle (inverted parchment → warm dark)
- Changelog section pulling from GitHub releases
- Testimonials / quotes from beta readers
- Language toggle (EN / NO) matching the app's i18n
