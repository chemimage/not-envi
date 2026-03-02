export const DATA_TYPES = new Map([
  [1, { name: "uint8", bytes: 1, ctor: Uint8Array, dv: "getUint8" }],
  [2, { name: "int16", bytes: 2, ctor: Int16Array, dv: "getInt16" }],
  [3, { name: "int32", bytes: 4, ctor: Int32Array, dv: "getInt32" }],
  [4, { name: "float32", bytes: 4, ctor: Float32Array, dv: "getFloat32" }],
  [5, { name: "float64", bytes: 8, ctor: Float64Array, dv: "getFloat64" }],
  [12, { name: "uint16", bytes: 2, ctor: Uint16Array, dv: "getUint16" }],
  [13, { name: "uint32", bytes: 4, ctor: Uint32Array, dv: "getUint32" }],
  [14, { name: "int64", bytes: 8, ctor: null, dv: "getBigInt64" }],
  [15, { name: "uint64", bytes: 8, ctor: null, dv: "getBigUint64" }]
]);
