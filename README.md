# Noord-Hollandse Modelspoordagen — Website

Website van de [Noord-Hollandse Modelspoordagen (NHMD)](https://www.nhmd.nl/).

## Tech stack

- [Astro](https://astro.build/) — static site generator
- [Tailwind CSS v4](https://tailwindcss.com/) — styling
- GitHub Pages — hosting
- GitHub Actions — automatic deploy on push to `main`

## Local development

```bash
npm install
npx astro dev
```

Site runs at `http://localhost:4321/nhmd-website/`.

## Build

```bash
npx astro build
```

Output goes to `dist/`. The base path and canonical URL come from the
`BASE_PATH` and `SITE_URL` env vars (see `astro.config.mjs`); the GitHub Pages
defaults apply when they are unset.

## Deploy

Push to `main` and GitHub Actions deploys to two targets:

| Workflow | Target | Base path |
| --- | --- | --- |
| `deploy.yml` | GitHub Pages: <https://bartbrinkman.github.io/nhmd-website/> | `/nhmd-website` |
| `deploy-ftp.yml` | The live site: <https://www.nhmd.nl/> | `/` |

To deploy manually: Actions tab > pick the workflow > Run workflow.

### FTP setup

`deploy-ftp.yml` uploads over FTPS. Until its secrets exist it skips itself, so
pushes stay green. Set these under Settings > Secrets and variables > Actions
(or with `gh secret set NAME`); never commit them:

| Secret | Value |
| --- | --- |
| `FTP_SERVER` | the host's FTP server name |
| `FTP_USERNAME` | the hosting account name |
| `FTP_PASSWORD` | the hosting account password |

Optional repository variables (Variables tab), for host-specific settings:

| Variable | Default | Meaning |
| --- | --- | --- |
| `FTP_REMOTE_DIR` | `/httpdocs/` | The web root on the server |
| `FTP_VERIFY_CERT` | `yes` | Set to `no` if the host's FTPS certificate does not match its name (common on shared hosting; the transfer stays encrypted) |

The upload never deletes: `lftp mirror` runs without `--delete`, so whatever is
already on the host (the old JouwWeb export, if any) stays until removed by
hand. Images and assets upload only when their size changes; HTML is always
re-sent.

When nhmd.nl moves over, also set up redirects for the old JouwWeb URLs
(`/informatie/verenigingen/...`, `/nieuws/2342378_...`).

## Tests

```bash
npm test          # date logic and link helpers in src/utils.ts
npm run test:edit # the dev click-to-edit integration
```

## Content maintenance

See `CLAUDE.md` for the content rules (in short: dates only in `events.json`).

### Editie (datum)

Edit `src/content/events.json`. The next upcoming entry drives the dates on the
homepage hero and the Bezoek page; past editions drop out automatically.

```json
{
  "date": "2027-02-27",
  "endDate": "2027-02-28",
  "title": "Noord-Hollandse Modelspoordagen",
  "description": "Zaterdag 10:00–16:00, zondag 10:00–15:00.",
  "location": "OSG Willem Blaeu, Robonsbosweg 11, Alkmaar",
  "type": "nmd",
  "link": "/bezoek"
}
```

### Exposanten

Cards come from `src/content/exposanten.json`; each has a page in
`src/pages/exposanten/`.

### Nieuws

One markdown file per bericht in `src/content/nieuws/`. Frontmatter: `title`,
`date`, `summary`, optional `image`, `gallery` (a key in `carousels.json`),
`videos` (YouTube ids) and `draft`.

### Photos

Galleries are in `src/content/carousels.json`. A year key (`"2027"`) adds an
edition to `/galerij` automatically. Use the admin for drag-and-drop:

```bash
npm run admin     # http://localhost:5179
npm run resize    # shrink public/images/pending/ to max 2000px
```

### Styling

- Colours and fonts: `@theme` block in `src/styles/global.css`
- Layouts: `src/layouts/Base.astro` (header, footer), `src/layouts/Page.astro` (content pages with hero)
