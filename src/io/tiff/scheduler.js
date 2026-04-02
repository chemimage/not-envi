import { APP_CONFIG, resolveHardwareConcurrencyLimit } from "../../app/config.js";
import {
  resolveSharedTaskConcurrency,
  resetSharedSchedulerForTests,
  scheduleSharedTask
} from "../../core/shared-scheduler.js";
import { createGeotiffDecodePool, destroyGeotiffDecodePool } from "./backend/geotiff-pool.js";

export function resolveTiffWorkerPoolSize(requested = null, maxWorkers = APP_CONFIG.tiff.standardWorkerPoolMax) {
  const configured = resolveHardwareConcurrencyLimit({
    fraction: APP_CONFIG.tiff.workerCoreFraction,
    min: APP_CONFIG.tiff.workerPoolMin,
    max: maxWorkers
  });
  const requestedSize = Number.isFinite(Number(requested)) ? Math.max(0, Math.floor(Number(requested))) : configured;
  return Math.max(0, Math.min(configured, requestedSize));
}

export function resolveTiffTaskConcurrency() {
  return resolveSharedTaskConcurrency();
}

let sharedPool = null;

export function getSharedTiffDecodePool(requestedSize = null) {
  const size = (typeof Worker !== "undefined") ? resolveTiffWorkerPoolSize(requestedSize) : 0;
  if (!sharedPool) {
    sharedPool = createGeotiffDecodePool(size);
  }
  return sharedPool;
}

export function scheduleTiffTask(ownerId, task) {
  return scheduleSharedTask(ownerId, task);
}

export function resetTiffConcurrencyForTests() {
  if (sharedPool) {
    try { destroyGeotiffDecodePool(sharedPool); } catch (_err) {}
  }
  sharedPool = null;
  resetSharedSchedulerForTests();
}
