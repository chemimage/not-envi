import { APP_CONFIG, resolveHardwareConcurrencyLimit } from "../app/config.js";

function createFairOwnerScheduler(maxConcurrency, minPerOwner = 1) {
  const queues = new Map();
  const activeByOwner = new Map();
  let running = 0;
  let cursor = 0;
  let pumping = false;
  let pumpRequested = false;

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
    pumpRequested = false;
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

  function requestPump() {
    if (pumpRequested) return;
    pumpRequested = true;
    Promise.resolve().then(() => {
      pump();
    });
  }

  return {
    schedule(owner, task) {
      const ownerKey = String(owner || "default");
      return new Promise((resolve, reject) => {
        if (!queues.has(ownerKey)) queues.set(ownerKey, []);
        queues.get(ownerKey).push({ task, resolve, reject });
        requestPump();
      });
    },
    cancel(owner) {
      const ownerKey = String(owner || "default");
      const queue = queues.get(ownerKey);
      if (!queue?.length) return 0;
      let cancelled = 0;
      for (const job of queue) {
        cancelled += 1;
        const err = new Error("Task cancelled");
        err.name = "AbortError";
        job.reject(err);
      }
      queues.delete(ownerKey);
      cleanupOwner(ownerKey);
      return cancelled;
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

export function resolveSharedTaskConcurrency() {
  return resolveHardwareConcurrencyLimit({
    fraction: APP_CONFIG.scheduler.coreFraction,
    min: APP_CONFIG.scheduler.minConcurrency,
    max: APP_CONFIG.scheduler.maxConcurrency
  });
}

let sharedScheduler = createFairOwnerScheduler(
  resolveSharedTaskConcurrency(),
  APP_CONFIG.scheduler.fairShareMinPerOwner
);

export function scheduleSharedTask(ownerId, task) {
  return sharedScheduler.schedule(ownerId, task);
}

export function cancelSharedTasks(ownerId) {
  return sharedScheduler.cancel(ownerId);
}

export function getSharedSchedulerStats() {
  return sharedScheduler.stats();
}

export function resetSharedSchedulerForTests() {
  sharedScheduler = createFairOwnerScheduler(
    resolveSharedTaskConcurrency(),
    APP_CONFIG.scheduler.fairShareMinPerOwner
  );
}
