import { Pool } from "geotiff";
import { APP_CONFIG, resolveHardwareConcurrencyLimit } from "../../app/config.js";

function createFairScheduler(maxConcurrency, minPerOwner = 1) {
  const queues = new Map();
  const activeByOwner = new Map();
  let running = 0;
  let cursor = 0;
  let pumping = false;

  function ownerIds() {
    return Array.from(queues.keys()).filter((owner) => {
      const queue = queues.get(owner);
      return (queue && queue.length > 0) || (activeByOwner.get(owner) || 0) > 0;
    });
  }

  function ownerCap() {
    const activeOwners = Math.max(1, ownerIds().length);
    return Math.max(minPerOwner, Math.floor(maxConcurrency / activeOwners) || 1);
  }

  function cleanupOwner(owner) {
    const queue = queues.get(owner);
    const active = activeByOwner.get(owner) || 0;
    if ((!queue || queue.length === 0) && active <= 0) {
      queues.delete(owner);
      activeByOwner.delete(owner);
    }
  }

  function runJob(owner, job) {
    running += 1;
    activeByOwner.set(owner, (activeByOwner.get(owner) || 0) + 1);
    Promise.resolve()
      .then(job.task)
      .then(job.resolve, job.reject)
      .finally(() => {
        running = Math.max(0, running - 1);
        activeByOwner.set(owner, Math.max(0, (activeByOwner.get(owner) || 1) - 1));
        cleanupOwner(owner);
        pump();
      });
  }

  function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (running < maxConcurrency) {
        const owners = ownerIds();
        if (!owners.length) break;
        const cap = ownerCap();
        let started = false;
        for (let offset = 0; offset < owners.length && running < maxConcurrency; offset += 1) {
          const index = (cursor + offset) % owners.length;
          const owner = owners[index];
          const queue = queues.get(owner);
          if (!queue?.length) continue;
          if ((activeByOwner.get(owner) || 0) >= cap) continue;
          cursor = (index + 1) % owners.length;
          runJob(owner, queue.shift());
          started = true;
        }
        if (started) continue;
        for (let offset = 0; offset < owners.length && running < maxConcurrency; offset += 1) {
          const index = (cursor + offset) % owners.length;
          const owner = owners[index];
          const queue = queues.get(owner);
          if (!queue?.length) continue;
          cursor = (index + 1) % owners.length;
          runJob(owner, queue.shift());
          started = true;
          break;
        }
        if (!started) break;
      }
    } finally {
      pumping = false;
    }
  }

  return {
    schedule(owner, task) {
      const ownerKey = String(owner || "default");
      return new Promise((resolve, reject) => {
        if (!queues.has(ownerKey)) queues.set(ownerKey, []);
        queues.get(ownerKey).push({ task, resolve, reject });
        pump();
      });
    },
    stats() {
      return {
        running,
        queuedOwners: ownerIds().length,
        queuedTasks: Array.from(queues.values()).reduce((sum, queue) => sum + queue.length, 0)
      };
    }
  };
}

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
  return resolveHardwareConcurrencyLimit({
    fraction: APP_CONFIG.tiff.taskCoreFraction,
    min: APP_CONFIG.tiff.taskMinConcurrency,
    max: APP_CONFIG.tiff.taskMaxConcurrency
  });
}

let sharedPool = null;
let fairScheduler = createFairScheduler(resolveTiffTaskConcurrency(), APP_CONFIG.tiff.fairShareMinPerDataset);

export function getSharedTiffDecodePool(requestedSize = null) {
  const size = (typeof Worker !== "undefined") ? resolveTiffWorkerPoolSize(requestedSize) : 0;
  if (!sharedPool) {
    sharedPool = new Pool(size);
  }
  return sharedPool;
}

export function scheduleTiffTask(ownerId, task) {
  return fairScheduler.schedule(ownerId, task);
}

export function resetTiffConcurrencyForTests() {
  if (sharedPool) {
    try { sharedPool.destroy(); } catch (_err) {}
  }
  sharedPool = null;
  fairScheduler = createFairScheduler(resolveTiffTaskConcurrency(), APP_CONFIG.tiff.fairShareMinPerDataset);
}
