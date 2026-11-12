// Each operation owns its own lease: an older completion cannot clear newer work.
export function createAnnotationWorkTracker(onChange = () => {}) {
  const jobs = new Set();

  function begin(ds, { items = [], point = null, slot = 1, label = "Computing" } = {}) {
    const job = {
      dsId: ds.id, slot, label, completed: null, total: null,
      items: items.map((item) => ({ id: item.id, points: item.points.map((p) => ({ ...p })) })),
      point: point ? { ...point } : null
    };
    jobs.add(job);
    onChange();
    return {
      update(completed, total) {
        if (!jobs.has(job)) return;
        job.completed = completed;
        job.total = total;
        onChange();
      },
      done() {
        if (jobs.delete(job)) onChange();
      }
    };
  }

  function list(ds, slot, drawings, point = null) {
    if (!ds) return [];
    const groups = new Map();
    for (const job of jobs) {
      if (job.dsId !== ds.id || job.slot !== slot) continue;
      const targets = job.point
        ? (point && point.x === job.point.x && point.y === job.point.y ? [{ point: job.point }] : [])
        : job.items.filter((item) => drawings.some((current) => current.id === item.id
          && JSON.stringify(current.points) === JSON.stringify(item.points)));
      for (const target of targets) {
        const key = target.point ? `point:${target.point.x},${target.point.y}` : `area:${target.id}`;
        if (!groups.has(key)) groups.set(key, { key, ...target, jobs: [] });
        groups.get(key).jobs.push(job);
      }
    }
    return Array.from(groups.values()).map(({ jobs: running, ...target }) => {
      const measured = running.every((job) => Number.isFinite(job.completed) && job.total > 0);
      const total = measured ? running.reduce((sum, job) => sum + job.total, 0) : null;
      const completed = measured ? running.reduce((sum, job) => sum + job.completed, 0) : null;
      return { ...target, label: [...new Set(running.map((job) => job.label))].join("; "),
        fraction: measured ? Math.min(1, Math.max(0, completed / total)) : null };
    });
  }

  return { begin, list };
}
