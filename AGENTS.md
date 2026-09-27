# Working in this repository

- `bun run check` before finishing any change. CI runs the same steps.
- `src/usage.ts` and `src/format.ts` are pure; keep omp runtime access in
  `src/source.ts` (AuthStorage) and `src/extension.ts` (events, UI).
- Usage data must come from omp's AuthStorage. Do not add a second OAuth
  client or read credential files: that duplicates omp's caching and
  rate-limit handling.
- omp packages are type-only dev dependencies. Do not import them at runtime;
  reach the host through the `ExtensionAPI` / `ExtensionContext` objects.
- The AuthStorage API changed shape in omp 18.3.0. `source.ts` feature-detects
  both; keep it that way and cover new shapes in `tests/source.test.ts`.
- `integration/` boots real omp in RPC mode. Run it against your installed
  build too: `OMP_BIN=$(which omp) bun run test:integration`.
