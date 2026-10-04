# NHMD Website — conventions

See [OVERVIEW.md](OVERVIEW.md) for stack and structure.

## Content rules

- **Dates only in [src/content/events.json](src/content/events.json).** Never in page copy — it goes stale. Phrase pages undated ("tijdens de Modelspoordagen", not "op 27 februari 2027"). The homepage hero and the Bezoek page read the next edition's date from that file. Weekday opening times ("zaterdag 10:00–16:00") are fine; they are not dates.
- **No edition numbers in copy** ("de veertiende keer"). They go stale and the old site contradicted itself on them.
- **One event, no agenda.** The site is about the Modelspoordagen only. `events.json` holds its editions (`type: "nmd"`, `link: "/bezoek"`); there is no calendar page and no other clubs' events.
- **No lezingen.** The program is banen, the treinenbeurs, the Lokdokter and the kinderbaan. Don't promise talks.
- **Address visitors as "u".**
- **Nieuwsberichten carry their date as metadata only** (`date` in the frontmatter). The body stays undated.

## Layout

- **Zebra sections.** Stacked page sections alternate the gray page ground and white (`bg-white border-y border-gray-200`). When adding, removing or reordering a section, re-check that no two neighbours share a background.

## Exposanten

[src/content/exposanten.json](src/content/exposanten.json) is the single source for the exposant cards (homepage, `/exposanten`, Over, Contact). `category` is `organisator` (the four clubs) or `aanwezig` (beurs, Lokdokter, gastbanen). Each entry has a page under [src/pages/exposanten/](src/pages/exposanten/); check both directions when adding one.

## Photos

Galleries live in [src/content/carousels.json](src/content/carousels.json). A key that is a year (`"2026"`) is an edition and appears on `/galerij` automatically, newest first; other keys belong to a page or a nieuwsbericht (`gallery:` in its frontmatter). Resize to max 2000px before adding (`npm run resize`).
