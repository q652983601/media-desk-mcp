// Bundle the unchanged upstream frontend with React; no DSH host packages.
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = join(root, 'dist', 'standalone')
await mkdir(output, { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: ['standalone/client.jsx'],
  outfile: join(output, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: 'chrome120',
  jsx: 'transform',
  jsxFactory: 'React.createElement',
  jsxFragment: 'React.Fragment',
  loader: { '.css': 'text' },
  define: { 'process.env.NODE_ENV': '"production"' },
  minify: true,
  legalComments: 'eof',
  metafile: true,
})
for (const [source, destination] of [
  ['standalone/index.html', 'index.html'],
  ['LICENSE', 'MEDIA-DESK-LICENSE.txt'],
  ['standalone/theme/LICENSE', 'THEME-LICENSE.txt'],
]) {
  await copyFile(join(root, source), join(output, destination))
}
const bytes = Object.values(result.metafile.outputs).reduce((n, file) => n + file.bytes, 0)
console.log(`Standalone frontend: ${(bytes / 1024).toFixed(1)} KB → ${output}`)
