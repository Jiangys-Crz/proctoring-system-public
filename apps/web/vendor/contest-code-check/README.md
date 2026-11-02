# Contest syntax comparison engine

Vendored from the user's Hydro `plugins/contest-code-check` reference, engine
`Syntax tokens 1.1.1 (variables only; C/C++ family)`.

- `token-worker.cjs` is the original bundled worker, renamed from `.js` so that
  it remains CommonJS under the hosting application's ES module package.
- `tokens/` contains the original portable Tree-sitter WASM grammars and their
  notices/licenses. `source/` preserves the original worker, tokenizer, matcher,
  engine and parser runtime source for inspection and redistribution.
- `LICENSE` is the original GNU AGPL v3 license. Parser/grammar licenses are
  included under `source/vendor/` and `tokens/licenses/`.
- The integration's `src/lib/code-check/engine.ts` adapts submission ID validation
  to accept this application's CUID IDs and changes the missing-assets message.
  Parsing, variable normalization, syntax-token matching, language grouping and
  historical maximum aggregation retain the reference behavior.

The engine needs no Java installation, native addon, external executable, or
additional package dependency. Its source snapshots and reports are stored in
MySQL. Next.js output tracing includes these assets for production deployment.

Capacity defaults match the reference: at most 10,000 source records per report,
256 KiB per source, 128 MiB total sources, 80 sources per comparison batch, one
active syntax worker across all contests. The following optional server variables
can override them: `CODE_CHECK_MAX_SUBMISSIONS`, `CODE_CHECK_MAX_CODE_BYTES`,
`CODE_CHECK_MAX_TOTAL_BYTES`, `CODE_CHECK_MAX_GROUP_SIZE`,
`CODE_CHECK_WORKER_HEAP_MB`, and `CODE_CHECK_TIMEOUT_SECONDS`.

This integration additionally estimates the complete report's historical version
comparisons and unique contestant result pairs before launching syntax workers.
It fails explicitly when either budget would be exceeded, explaining how to
narrow the scope or change server limits; it never silently drops result pairs.

| Server variable | Default |
| --- | ---: |
| `CODE_CHECK_MAX_SUBMISSIONS` | 10000 |
| `CODE_CHECK_MAX_CODE_BYTES` | 262144 (256 KiB) |
| `CODE_CHECK_MAX_TOTAL_BYTES` | 134217728 (128 MiB) |
| `CODE_CHECK_MAX_GROUP_SIZE` | 80 |
| `CODE_CHECK_MAX_VERSION_PAIRS` | 1000000 |
| `CODE_CHECK_MAX_RESULT_PAIRS` | 100000 |
| `CODE_CHECK_WORKER_HEAP_MB` | 512 |
| `CODE_CHECK_TIMEOUT_SECONDS` | 180 per batch |
