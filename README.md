# Unit Transfer

Log stock moving between units (by car, van or truck), get a PDF challan, keep a searchable history.

- Opens with a fresh transfer log (UT-YYYYMMDD-001, 002, …)
- Pick From unit → To unit, vehicle and driver, search the product sheet, add quantities
- Save & Download PDF; every transfer is saved to History (view, re-download PDF, delete)

## Setup
1. Supabase → SQL Editor → run `sql/setup.sql` (tables + 382-item product sheet).
2. `cp .env.example .env` and fill in your Supabase URL + anon key.
3. `npm install && npm run dev`

Deploy: Render static site, build `npm install; npm run build`, publish `dist`,
env vars `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.
