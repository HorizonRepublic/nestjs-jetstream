# SEO indexing fixes — task brief

Working notes for whoever picks this up. Do not commit this file.

## Context

The docs site moved to the custom domain `nestjs-jetstream.horizon-republic.dev` on
2026-05-27 (commit `33fdd17`, `website/static/CNAME`). Search Console diagnostics run on
2026-07-26 against both properties show the site is being crawled but **not indexed**.

Search Console facts:

- Sitemap on the new domain: `submitted: 110, indexed: 0`. Last downloaded by Google
  `2026-05-27T17:29:56Z` — it has not been re-fetched since the day it was submitted.
- URL Inspection verdicts on the new domain:
  | URL | coverageState | lastCrawlTime |
  | --- | --- | --- |
  | `/` | Crawled - currently not indexed | 2026-06-05 |
  | `/docs` | Crawled - currently not indexed | 2026-06-08 |
  | `/docs/patterns/rpc` | Crawled - currently not indexed | 2026-06-19 |
  | `/docs/guides/health-checks` | Crawled - currently not indexed | 2026-07-03 |
  | `/docs/getting-started/installation` | URL is unknown to Google | — |
- Only four pages received any impressions in two months: `/docs`,
  `/docs/getting-started/why-jetstream`, `/docs/guides/custom-codec`,
  `/docs/guides/health-checks`. Zero clicks across all of them.

What is **not** broken, so leave it alone: the 301 from `horizonrepublic.github.io`
preserves the path, `rel="canonical"` is correct, `robots.txt` allows all major crawlers,
the static HTML carries the full content (SSG works), breadcrumbs pass rich-results
validation, and `package.json` `homepage` / GitHub About / README already point at the
new domain.

## Root cause

Of the 116 URLs in `sitemap.xml`, **85 are auto-generated TypeDoc pages** under
`/docs/reference/**`, and their meta descriptions are scraped garbage:

```
/docs/reference/api                             → description="Enumerations"
/docs/reference/api/classes/JetstreamClient     → description="Defined in91"
/docs/reference/api/classes/JetstreamHealthIndicator → description="Defined in22"
```

That is the classic thin/low-value content profile. On a two-month-old domain with no
history it suppresses the whole site, not just those pages.

Secondary: 79 of 116 URLs carry no `<lastmod>` at all. The `lastmod: 'date'` setting
pulls from git, and TypeDoc output is generated at build time so it has no git history.
The remaining 37 all share the same date, `2026-06-15`.

## Decision

Keep the API reference on the site — it stays in the sidebar and in local search
(`@cmfcmf/docusaurus-search-local`), which is its actual value. Remove it from search
indexing only. It has produced zero impressions, so there is nothing to lose.

Do **not** use `unlisted: true`. It would give the right `noindex` but also hide the
pages from the sidebar and local search, which defeats the point.

## Tasks

### 1. Add `noindex` to generated TypeDoc pages

TypeDoc writes markdown to `website/docs/reference/api` (`typedoc.json:6`). There is no
frontmatter field for `noindex`, so the meta tag has to go into the MDX body — inject it
immediately after the frontmatter block of every generated `.md`:

```mdx
<head>
  <meta name="robots" content="noindex" />
</head>
```

Implement as a post-generation step wired into `docs:api` (`package.json:68`), not as a
manual edit — new symbols must pick this up automatically on every regeneration. Leave
the TypeDoc invocation itself untouched so the pinned `typedoc` / `typescript@6` versions
stay upgradeable.

The Docusaurus sitemap plugin automatically filters out any page carrying a `noindex`
meta tag, so this also shrinks `sitemap.xml` with no extra configuration.

### 2. Exclude `/404` from the sitemap

`website/docusaurus.config.ts:34`:

```ts
sitemap: {
  lastmod: 'date',
  changefreq: 'weekly',
  priority: 0.5,
  filename: 'sitemap.xml',
  ignorePatterns: ['/404'],
},
```

`/docs/reference/**` does not need to be listed here — task 1 already covers it via the
noindex filter. Add it only if verification shows otherwise.

### 3. Verify before handing back

Run `pnpm docs:build`, then against the built output confirm:

- `sitemap.xml` drops from 116 to roughly 30 URLs
- no `/docs/reference/` entry and no `/404` entry remains
- every remaining URL has a `<lastmod>`, and the dates vary (git-derived, not one shared
  date)
- a generated reference page in the build output contains
  `<meta name="robots" content="noindex">`
- the API reference is still reachable in the sidebar and still returns results in local
  site search

## Follow-up, manual, in the Search Console UI — not code

Not part of this task; listed so it does not get lost. Do these **after** the fix is
deployed:

1. Remove and re-submit `sitemap.xml` on the `sc-domain:nestjs-jetstream.horizon-republic.dev`
   property, to reset the stale `lastDownloaded`.
2. Request Indexing for `/`, `/docs`, `/docs/getting-started/installation`,
   `/docs/patterns/rpc`, `/docs/guides/health-checks`. `installation` is the priority —
   it is in the sitemap but Google reports it as entirely unknown.
3. Update the inbound link on `www.nestjs.io/packages/horizonrepublic-nestjs-jetstream`,
   which still points at the old `horizonrepublic.github.io` URL. On a domain with no
   history each external link carries disproportionate weight.
4. Keep the old `https://horizonrepublic.github.io/nestjs-jetstream/` property. Change of
   Address is not available for it — that tool operates at host level and the old
   property is a subdirectory on a shared host — so the property is the only way to watch
   signals transfer.

## Caveat

Google never states why a page is `Crawled - currently not indexed`, so the TypeDoc
attribution is a hypothesis, well supported by the site's composition but not confirmed.
The second factor is simply domain age: even with flawless technical setup, re-evaluation
after a migration takes months. Expect the fix to shorten the recovery, not to produce an
immediate jump.
