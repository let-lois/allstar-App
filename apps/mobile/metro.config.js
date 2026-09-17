/**
 * Metro, with exactly one change: the admin console is stubbed out.
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
 * The swap happens *after* normal resolution, on the resolved absolute path,
 * rather than by matching the specifier. `App.tsx` asks for `./adminRoutes`,
 * and a specifier match would also catch any other file that happens to end
 * that way; a path match cannot.
 */
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

const WEB_ADMIN_ROUTES = path.resolve(__dirname, '../../src/adminRoutes.tsx')
const STUB = path.resolve(__dirname, 'src/admin-routes-stub.tsx')

const upstream = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const resolved = (upstream ?? context.resolveRequest)(context, moduleName, platform)
  if (
    resolved &&
    resolved.type === 'sourceFile' &&
    path.resolve(resolved.filePath) === WEB_ADMIN_ROUTES
  ) {
    return { type: 'sourceFile', filePath: STUB }
  }
  return resolved
}

module.exports = config
