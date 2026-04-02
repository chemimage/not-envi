import { Pool } from "geotiff";

export function createGeotiffDecodePool(size) {
  return new Pool(size);
}

export function destroyGeotiffDecodePool(pool) {
  if (pool && typeof pool.destroy === "function") {
    pool.destroy();
  }
}
