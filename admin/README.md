# NHMD Admin

Local tool to manage the site's carousels and prep the `public/images/`
folder for static distribution. Reads/writes `src/content/carousels.json`
and files in `public/images/` directly.

Not part of the Astro build — it lives alongside the site in this repo
under `admin/`.

## Run

From the repo root:

```bash
npm run admin        # starts the server on http://localhost:5179
npm run resize       # CLI: shrinks every image in public/images/pending/ to max 2000px
```

## Model

- A **carousel** = a folder in `public/images/` plus an entry in
  `carousels.json`. The left sidebar lists all carousels.
- **pending/** is the staging area, NOT a carousel. Images waiting to be
  assigned sit in the right-hand "Pending" rail.
- Images live in exactly one place. Dragging an image anywhere moves the
  file on disk AND keeps `carousels.json` in sync.

## UI

- **Select a carousel** on the left — its images appear in order in the
  middle pane. Edit title/description inline, drag to reorder, click a
  thumbnail for fullscreen.
- **Add an image to a carousel** — drag a thumbnail from the Pending rail
  onto a carousel row in the sidebar, or onto the editor pane when that
  carousel is open.
- **Remove an image from a carousel** — drag the slide onto the Pending
  rail. The file moves to `public/images/pending/`.
- **Save** — writes the current carousel's order/titles/descriptions to
  `carousels.json`. Cmd/Ctrl+S works.
- **Delete carousel** — removes the entry from `carousels.json` only.
  Folder and images stay on disk (show up as italic "no-metadata" rows).
- **Add carousel** — creates `public/images/<id>/` plus an empty entry in
  `carousels.json`.

## Resize

`npm run resize` walks `public/images/pending/` and shrinks anything where
the long edge exceeds 2000px. Respects EXIF orientation, writes via
tmp-file + rename, skips already-small files. Override with
`MAX_DIMENSION=1600 npm run resize`.

## Notes

- Default port is 5179 (chosen to stay clear of Astro's 4321+ auto-scan).
  Override with `PORT=5180 npm start`.
- Folder/carousel ids restricted to `[a-z0-9_-]+`.
- JSON is pretty-printed with a trailing newline so git diffs stay clean.
