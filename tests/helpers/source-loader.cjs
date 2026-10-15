const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Execute application TypeScript with the actual crypto/protocol dependencies.
// Only Angular decorators and explicitly supplied platform boundaries are stubbed.
module.exports = function sourceLoader(stubs = {}) {
  const root = path.resolve(__dirname, '../..')
  const cache = new Map()
  const angular = new Proxy({}, { get: () => () => () => undefined })
  function load(file) {
    file = path.resolve(root, file)
    if (cache.has(file)) return cache.get(file).exports
    const module = new Module(file)
    module.filename = file
    module.paths = Module._nodeModulePaths(path.dirname(file))
    cache.set(file, module)
    module.require = (name) => {
      if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name]
      if (name === '@angular/core') return angular
      const source = name.startsWith('src/') ? path.resolve(root, name) :
        name.startsWith('.') ? path.resolve(path.dirname(file), name) : undefined
      if (source && Object.prototype.hasOwnProperty.call(stubs, source)) return stubs[source]
      if (source && fs.existsSync(source + '.ts')) return load(source + '.ts')
      return require(require.resolve(name, { paths: [path.dirname(file)] }))
    }
    const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
        experimentalDecorators: true, emitDecoratorMetadata: false, esModuleInterop: true }
    }).outputText
    module._compile(compiled, file)
    return module.exports
  }
  return load
}
