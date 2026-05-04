# Database schema

_Placeholder. Owner: A3. Slice: S1._

Source of truth: `supabase/migrations/`. Slice S1 produces a human-readable
companion that maps every table to:
- which V2 module reads/writes it
- which V2 routes own its lifecycle
- which RLS policies apply

Until S1 lands, refer directly to the migration files +
`supabase/migrations/README.md`.
