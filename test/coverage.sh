#!/usr/bin/env bash
# Coverage for the test suite: JS via Node's built-in coverage (failing below 100%), Rust via an
# instrumented build of the addon that the same tests run against.
#
# Needs cargo-llvm-cov (`cargo install cargo-llvm-cov`) and `rustup component add llvm-tools`.
# The only Rust lines left uncovered are the `#[napi]` lines in bindings.rs: the macro's handling of
# wrong-typed arguments, which lib/index.js rejects before they reach Rust.
set -euo pipefail
cd "$(dirname "$0")/.."

# JS coverage is measured on lib/index.js, the output tsc compiles from src/index.ts. (Mapping it back to
# the .ts source through source maps matched no files and reported a vacuous 100%, so it isn't used.)
echo "== JS (lib/index.js, compiled from src/index.ts)"
node --test --experimental-test-coverage --test-coverage-include='lib/index.js' \
  --test-coverage-lines=100 --test-coverage-branches=100 --test-coverage-functions=100 \
  test/*.test.js | sed -n '/start of coverage report/,/end of coverage report/p'

echo "== Rust (native/src)"
# The instrumented addon replaces the release one in lib/; put the release build back however this ends.
# The coverage settings are exported only inside the subshell below, so this rebuild stays uninstrumented.
trap 'npm run build >/dev/null 2>&1 || echo "warning: npm run build failed; rebuild before using lib/" >&2' EXIT
(
  eval "$(cd native && cargo llvm-cov show-env --export-prefix 2>/dev/null)"
  (cd native && cargo llvm-cov clean --workspace)
  npx napi build --platform --manifest-path native/Cargo.toml --output-dir lib --js binding.js --dts binding.d.ts
  node --test test/*.test.js >/dev/null
  # napi builds for the host triple explicitly, so the report has to look under that target directory.
  (cd native && cargo llvm-cov report --target "$(rustc -vV | sed -n 's/^host: //p')" --show-missing-lines)
)
