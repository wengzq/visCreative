import { run } from './main'
import { serveMcp } from './mcp'

if (process.argv[2] === 'mcp') {
  // stdout is reserved for MCP messages
  process.stdin.setEncoding('utf8')
  await serveMcp(process.env, process.stdin, line => process.stdout.write(line))
  process.exit(0)
}

const code = await run(process.argv.slice(2), process.env, {
  stdin: async () => {
    process.stdin.setEncoding('utf8')
    let input = ''
    for await (const chunk of process.stdin) input += chunk
    return input
  },
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
})
await new Promise<void>(resolve => process.stdout.write('', () => resolve()))
process.exit(code)
