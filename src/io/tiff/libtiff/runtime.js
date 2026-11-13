import createModule from "../../../../wasm/libtiff/pkg/libtiff.mjs";
/** Share compiled code across workers without embedding another WASM payload. */
export function createLibtiffModule(compiled) {
  return createModule({
    printErr() {},
    instantiateWasm(imports, ready) {
      const instance = new WebAssembly.Instance(compiled, imports);
      ready(instance, compiled);
      return instance.exports;
    }
  });
}

export function libtiffResult(module, result) {
  if (result > 0) return result;
  if (module.io?.error) throw module.io.error;
  throw new Error(module.UTF8ToString(module._hyve_error()) || "libtiff rejected the TIFF operation.");
}

/** Asyncify suspends C only at bounded I/O; callers serialize a handle's calls. */
export function callLibtiff(module, name, args = []) {
  return module.ccall(name, "number", args.map(() => "number"), args, { async: true });
}
