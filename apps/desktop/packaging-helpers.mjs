export const visLauncher = `#!/bin/sh
set -eu
entry=$0
hops=0
while :; do
  cli_dir=$(CDPATH= cd -P -- "$(dirname -- "$entry")" && pwd)
  entry="$cli_dir/$(basename -- "$entry")"
  [ -L "$entry" ] || break
  hops=$((hops + 1))
  if [ "$hops" -gt 40 ]; then
    printf '%s\\n' 'Too many symbolic links in the vis launcher' >&2
    exit 1
  fi
  target=$(readlink "$entry")
  case "$target" in
    /*) entry=$target ;;
    *) entry="$cli_dir/$target" ;;
  esac
done
ELECTRON_RUN_AS_NODE=1 exec "$cli_dir/../../MacOS/visCreative" "$cli_dir/vis.mjs" "$@"
`

export function packageManagerInvocation(executable, args, node = process.execPath) {
  return /\.(?:cjs|mjs|js)$/i.test(executable)
    ? { command: node, args: [executable, ...args] }
    : { command: executable, args }
}

export function assertStagedTarget(staged, requested = staged) {
  if (!staged || !['arm64', 'x64'].includes(staged.arch) || staged.platform !== 'darwin' || typeof staged.electronVersion !== 'string') {
    throw new Error('Stage a supported desktop target before packaging')
  }
  if (staged.arch !== requested.arch || staged.platform !== requested.platform) {
    throw new Error(`Staged natives target ${staged.platform}-${staged.arch}; requested ${requested.platform}-${requested.arch}`)
  }
  return staged
}
