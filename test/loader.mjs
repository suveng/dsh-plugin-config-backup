/**
 * Test-only loader hook: resolve the Harness packages from the installed
 * DeepSeek Harness instead of a local `node_modules`, so this repository stays
 * dependency-free.
 *
 * The plugin's peers (`@deepseek-ai/cordis`, `dsh-typert-protocol`, `dsh-tools`,
 * `schemastery`) are supplied by the Host at run time. Set `DSH_INSTALL` to the
 * installation root when it is not the default global one.
 * Usage: `node --import ./test/loader.mjs --test test/service.test.js`
 */
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
const install = process.env.DSH_INSTALL ?? '/Users/zaclaim/.nvm/versions/node/v24.18.0/lib/node_modules/@deepseek-ai/dsh'
const roots = [`${install}/node_modules/`, `${install}/../`]
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('@deepseek-ai/')) {
      for (const root of roots) {
        const base = root + specifier
        for (const candidate of [base + '/lib/index.mjs', base + '/lib/index.js', base + '/lib/index.cjs']) {
          if (existsSync(candidate)) return { url: pathToFileURL(candidate).href, shortCircuit: true, format: candidate.endsWith('.mjs') ? 'module' : undefined }
        }
      }
    }
    return next(specifier, context)
  },
})
