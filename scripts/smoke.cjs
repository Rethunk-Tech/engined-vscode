'use strict'
// Load the bundle the way VS Code's extension host does. Outside the host `vscode` cannot resolve,
// so reaching that require proves the file parsed as CommonJS; anything else is a real failure.
const bundle = process.argv[2] ?? './dist/extension.cjs'
try {
  require(require('node:path').resolve(bundle))
} catch (e) {
  if (e.code !== 'MODULE_NOT_FOUND' || !e.message.includes("'vscode'")) {
    throw e
  }
}
