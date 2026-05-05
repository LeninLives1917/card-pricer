# tests/

A7 (Testing/QA) — Card-Pricer V2 test suite. See `docs/V2_ARCHITECTURE.md` §7
for the full regression + feature matrix (~50 + ~20 cases).

## Framework: `node:test`

We use Node's built-in test runner (`node --test`) — **no devDependency**.
Reasons:

1. **Pure ESM, zero install cost.** The repo is `"type": "module"` and ships
   to Render with no devDeps. `node:test` runs ESM natively in Node 20+;
   adding Vitest would pull ~30 MB of devDeps (Vitest + Vite + chai) onto
   the build, plus a config file, for ergonomics we don't yet need.
2. **Stable API in Node 20 LTS.** `node:test` and `node:assert/strict`
   are stable in 20.x (our prod target per `render.yaml`) and 24.x (local
   dev). Watch mode (`--watch`) and coverage (`--experimental-test-coverage`)
   are built in.
3. **Aligns with the V2 audit principle of minimum surface.** Adding a test
   framework now is a one-way door — every later sub-agent inherits its
   conventions. Starting with the runtime built-in keeps that surface
   smallest until a missing capability forces an upgrade. If it does (the
   most likely trigger is snapshot testing for the widget V1/V2 parity in
   S23), we revisit then; the spec files written against `node:test` port
   to Vitest with mostly-mechanical edits.

If a future sub-agent wants Vitest, the migration is contained: spec files
already use the standard `test()` + `assert` shape, and helper modules in
`tests/helpers/` are framework-agnostic.

## Running

```bash
npm test                # one-shot run, every spec under tests/
npm run test:watch      # re-run on change (Node 20.6+)
```

The proposed `package.json` additions are:

```jsonc
{
  "scripts": {
    "test":       "node --test --test-reporter=spec \"tests/**/*.spec.js\"",
    "test:watch": "node --test --watch --test-reporter=spec \"tests/**/*.spec.js\""
  }
}
```

The glob form is required: `node --test tests/` tries to resolve `tests` as a
single module entry. The glob matches every `*.spec.js` file under `tests/**`
and skips fixtures, helpers, and the `.gitkeep` placeholders. No
`devDependencies` are required for the runner itself. If a spec needs
something beyond `node:assert` and `node:test`, it lands as a per-spec dep
and is discussed in the slice's commit message.

## Directory convention

```
tests/
├── regression/   ← one spec per behaviour in V2_AUDIT §1 + §5 (RG-01..RG-50)
│                  Must pass before V2 ships. Pin V1-equivalent behaviour.
├── new/          ← V2-only feature specs (F1-01..F26-01)
│                  Each new feature lands its spec in the same commit as the code.
├── fixtures/     ← cached API responses (Pokémon, Scryfall, eBay), sample card
│                  images, golden snapshots. Static; reviewed by hand on add.
└── helpers/      ← framework-agnostic test utilities — fake Supabase client,
                   fake Anthropic client, mockFetch. See helpers/setup.js.
```

### Where to add a new test for an in-flight slice

- Regression for V1 behaviour the slice must preserve → `tests/regression/<area>.spec.js`.
  Reference the audit ID (`RG-NN`) in the test name.
- New behaviour the slice introduces → `tests/new/<feature>.spec.js`. Reference
  the feature ID (`F18-01`, etc.) in the test name.
- Shared mocks or builders → `tests/helpers/`. Keep these importable from any
  spec (no path tricks); they live behind `import { ... } from '../helpers/setup.js'`.
- Fixture data → `tests/fixtures/<source>/<case>.json`. Never inline more than
  ~30 lines of fixture data in a spec — pull it into `fixtures/` instead.

Spec filenames end in `.spec.js`. The runner picks them up automatically;
no glob configuration is needed.
