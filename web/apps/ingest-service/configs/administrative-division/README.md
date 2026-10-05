# Administrative division data

- `MCA_2025-12-31.json`: immutable Ministry of Civil Affairs API snapshot.
- `MCA_2025-12-31.meta.json`: source URLs, effective date, counts and SHA-256.
- `region-v1.crosswalk.json`: reviewed historical-code decisions for `region-v1`.

Refresh and validate the official snapshot with:

```bash
pnpm region:snapshot
```

After applying migration `008`, seed a database with:

```bash
PG_URL=postgres://... pnpm region:seed
```

Do not replace a published dataset version with different content. The seed command rejects an
existing version when its stored hash differs. Ambiguous historical codes must remain
`auto_apply=false` until documentary evidence establishes one safe target.
