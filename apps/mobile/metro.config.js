/**
 * Metro, with two changes: the admin console is stubbed out, and the web app's
 * images are inlined.
 *
 * There is deliberately no `watchFolders`, `resolver.nodeModulesPaths`,
 * `resolver.extraNodeModules` or `resolver.disableHierarchicalLookup` here.
 * Expo has configured Metro for monorepos automatically since SDK 52 and the
 * guide is explicit that those four should be *absent* rather than set —
 * setting them back is how a project acquires a config nobody can explain.
 *
 * What this does add is a resolver swap. The DOM shell imports the whole
 * All-Star web app, and that app's `src/adminRoutes.tsx` lazy-loads ten
 * desktop-only console screens. Metro follows a dynamic `import()` into a
 * chunk rather than leaving it on a server, so without this the phone bundle
 * would carry the entire office console — and `expo export` failed outright on
 * the shared chunk that produced.
 *
 * The second swap is the web app's two images. Metro emits a bare relative URL
 * for an imported asset, so the file has to sit next to the DOM component's
 * page — and Expo's two export paths disagree about whether it does.
 * `exportEmbedAsync.js` prefixes each DOM asset's `httpServerLocation` with
 * `www.bundle`, so a real build resolves it; `exportDomComponents.js`, which is
 * `expo export` and so EAS Update, does not, and the page asks for a sibling
 * that was written to `dist/assets/`. Both layouts agree on a URL with nothing
 * to resolve, so the import is swapped for a generated data-URI module. The web
 * app's own build is untouched and keeps its hashed, cacheable PNG.
 *
 * Every swap happens *after* normal resolution, on the resolved absolute path,
 * rather than by matching the specifier. `App.tsx` asks for `./adminRoutes`,
 * and a specifier match would also catch any other file that happens to end
 * that way; a path match cannot.
 */
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

const WEB_SRC = path.resolve(__dirname, '../../src')
const SELF_SRC = path.resolve(__dirname, 'src')

/**
 * Resolved web-app path -> the module the phone bundle gets instead.
 *
 * Generated entries come from `scripts/gen-shell-assets.mjs`;
 * `npm run verify:shell-assets` fails if one drifts from its PNG.
 */
const SWAPS = new Map([
  [path.join(WEB_SRC, 'adminRoutes.tsx'), path.join(SELF_SRC, 'admin-routes-stub.tsx')],
  [path.join(WEB_SRC, 'assets/logo.png'), path.join(SELF_SRC, 'assets/logo.png.ts')],
  [path.join(WEB_SRC, 'assets/icon-192.png'), path.join(SELF_SRC, 'assets/icon-192.png.ts')],
])

const upstream = config.resolver.resolveRequest

/**
 * What file did Metro land on?
 *
 * Two shapes, and the difference is easy to miss: source resolves to
 * `{ type: 'sourceFile', filePath }` and an image to
 * `{ type: 'assetFiles', filePaths }` — plural, because one `.png` import can
 * resolve to a whole family of `@2x`/`@3x` files. A swap table that only reads
 * `sourceFile` compiles, runs, and silently never fires on an asset, which is
 * exactly what it did first time round: the bundle came out byte-identical.
 */
function resolvedPath(resolved) {
  if (!resolved) return null
  if (resolved.type === 'sourceFile') return path.resolve(resolved.filePath)
  if (resolved.type === 'assetFiles' && resolved.filePaths?.length) {
    return path.resolve(resolved.filePaths[0])
  }
  return null
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = (upstream ?? context.resolveRequest)(context, moduleName, platform)
  const from = resolvedPath(resolved)
  const swap = from && SWAPS.get(from)
  // Always a source file: every swap target is a module, including the ones
  // standing in for an image.
  return swap ? { type: 'sourceFile', filePath: swap } : resolved
}

module.exports = config
