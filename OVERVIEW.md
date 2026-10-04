# NHMD Website — Overview

A rebuild of the [Noord-Hollandse Modelspoordagen](https://www.nhmd.nl/) website (currently on JouwWeb) as a static Astro site. It uses the same technical approach and component set as the [MSA website](https://github.com/bartbrinkman/msa-website), with its own identity, content and sitemap.

## Tech stack

- **Astro 6** — static site generator
- **Tailwind CSS v4** — styling
- **Google Fonts** — Exo 2 (headings), Inter (body)
- **GitHub Pages** + **GitHub Actions** (`withastro/action@v6`) — hosting & CI
- Dev-only click-to-edit toolbar (`integrations/edit/`) and local admin (`admin/`), both carried over from the MSA site

## Sitemap

```
/                         Home: hero slideshow + poster, wat is er te zien, praktisch, nieuws, vorige editie
/bezoek                   Bezoekersinformatie: openingstijden, entree, adres, parkeren, OV
/exposanten/              Overview: organiserende verenigingen + ook aanwezig
  waeghspoor              AMG "Het Waeghspoor"
  mvw-waterland           Modelbouw Vereniging Waterland
  modelspoorclub-alkmaar  Modelspoorclub Alkmaar (Zijperspoor)
  westfriese-modelspoorclub
  treinenbeurs
  lokdokter
  gastbanen
/galerij                  One mosaic gallery per edition (2026, 2025, 2024)
/nieuws/                  Nieuwsberichten (markdown collection), each with its own page
/over                     Over de NMD (footer)
/deelnemen                For exposanten and handelaren (footer)
/contact
```

Old JouwWeb URLs (`/informatie/verenigingen/...`, `/nieuws/2342378_...`) are not redirected; set up redirects at the host when nhmd.nl moves over.

## Design

- **Palette from the event poster**: green primary (`#0b6623`), NS-yellow `sein` (`#ffc917`) as the single interactive highlight, signal red accent (`#d7141a`). Tokens in the `@theme` block of `src/styles/global.css`.
- **Type**: Exo 2 extra-bold uppercase headings, echoing the poster lettering.
- **Wordmark**: "NHMD" set in Exo 2 black, NS-yellow, beside the full name. No logo image. The favicon (`favicon.svg`/`.ico`) stacks NH over MD in yellow on the green tile, drawn as shapes since a favicon can't load the web font.

## Shared components (from the MSA site)

`Carousel` (paged mosaic + lightbox), `EventCard`, `DateBlock`, `LayoutCard` (exposant cards), `BrochureStand` (poster on a stand in the hero), `Base`/`Page` layouts.

Changes from MSA: event types are `nmd | expositie | opendag | beurs`; event links may be external URLs (`href()` / `isExternal()` in `src/utils.ts`); `Page` takes `kicker` instead of `frequency`; nieuwsberichten get their own pages with optional `gallery` and YouTube `videos`; there is no next-event strip under the nav and no agenda page, since the site covers a single event.

## Content sources

Text, photos and facts were taken from nhmd.nl (scraped 4 October 2026) and the 2027 poster; the 2026 gallery photos came from the MSA repo.

## Deployment

- `astro.config.mjs` defaults to `base: '/nhmd-website'` for GitHub Pages; set `SITE_URL=https://www.nhmd.nl` and `BASE_PATH=/` to build for the real domain.
- All internal links go through `asset()` so the base path is a config change only.
