#!/usr/bin/env bash
# Checks the published types the way a user meets them: packs the package, runs Are the Types Wrong on
# the tarball, then compiles a consumer project against it with TypeScript $1 (default 5), under each
# module setup that version supports, with strict on and skipLibCheck off.
set -euo pipefail
ts="${1:-5}"
root="$(cd "$(dirname "$0")/../.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "${work:?}"' EXIT

cd "$root"
npm run build:ts >/dev/null
npm pack --pack-destination "$work" --silent >/dev/null
tarball="$(ls "$work"/*.tgz)"
npx attw "$tarball"

mkdir "$work/consumer"
cp test/types/*.mts test/types/*.cts "$work/consumer/"
cd "$work/consumer"
echo '{"name":"consumer","private":true}' > package.json
npm install --silent --no-audit --no-fund "typescript@$ts" @types/node@22 "$tarball"
echo "TypeScript $(npx tsc --version)"

failed=0
compile() { # module resolution target file
  npx tsc --noEmit --strict --module "$1" --moduleResolution "$2" --target "$3" --types node "$4"
}
check() {
  if out=$(compile "$@" 2>&1); then echo "ok    $*"; else echo "FAIL  $*"; echo "$out"; failed=1; fi
}
check nodenext nodenext es2022 usage.mts
check nodenext nodenext es2022 usage.cts
check node16 node16 es2022 usage.mts
check esnext bundler es2022 usage.mts
if [ "${ts%%.*}" -lt 6 ]; then # TypeScript 6 deprecated, and 7 removed, the ES5 target and node10 resolution
  check esnext bundler es5 usage.mts
  check commonjs node10 es5 usage.cts
fi
# A project that limits `types` still gets Buffer, through the reference in lib/index.d.ts.
cat > tsconfig.json <<'JSON'
{ "compilerOptions": { "strict": true, "noEmit": true, "module": "nodenext", "moduleResolution": "nodenext",
                       "target": "es2022", "types": [] },
  "files": ["usage.mts"] }
JSON
if out=$(npx tsc -p tsconfig.json 2>&1); then echo "ok    types: [] usage.mts"; else echo "FAIL  types: [] usage.mts"; echo "$out"; failed=1; fi
if compile nodenext nodenext es2022 must-fail.mts >/dev/null 2>&1; then
  echo "FAIL  must-fail.mts compiled, so these checks can't catch a type error"; failed=1
else
  echo "ok    must-fail.mts is rejected"
fi
exit "$failed"
