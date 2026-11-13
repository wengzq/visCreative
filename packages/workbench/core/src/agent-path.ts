import { delimiter } from 'node:path'

/** User-installed tools win over packaged fallbacks; vis keeps its reserved first position. */
export function agentPath(options: {
  cliBinDir?: string | undefined
  fallbackDirs?: readonly string[] | undefined
  base?: string | undefined
  pathDelimiter?: string
}): string | undefined {
  const separator = options.pathDelimiter ?? delimiter
  if (!options.cliBinDir && !options.fallbackDirs?.length) return options.base
  const entries = options.base?.split(separator) ?? []
  const paths = options.cliBinDir ? [options.cliBinDir, ...entries.filter(path => path !== options.cliBinDir)] : entries
  for (const directory of options.fallbackDirs ?? []) if (directory && !paths.includes(directory)) paths.push(directory)
  return paths.join(separator)
}
