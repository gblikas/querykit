### QueryKit Demo (Next.js)

This is the demo website for QueryKit. It showcases the QueryKit DSL running in the browser, translating human-friendly filters to Drizzle/SQL and querying an in-browser Postgres (PGlite).

For full docs, API, and examples, visit the QueryKit repository: [github.com/gblikas/querykit](https://github.com/gblikas/querykit)

### Quick start

```bash
cd examples/qk-next
pnpm install
pnpm dev
```

Open http://localhost:3000.

`pnpm dev` and `pnpm build` first compile the library from this checkout into the installed `@gblikas/querykit`. Restart them after changing library source.

### Build and run

```bash
cd examples/qk-next
pnpm build
pnpm start
```

### Optional environment

- Set `NEXT_PUBLIC_SITE_URL` to your site URL to improve canonical metadata.

### Tech

- Next.js App Router
- QueryKit (DSL → Drizzle/SQL)
- Drizzle ORM + PGlite (in-browser Postgres)
- Tailwind CSS

License: See the repository root for licensing information.
