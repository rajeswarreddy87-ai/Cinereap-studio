import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Tiny filesystem-backed job store. One JSON file per job. No DB required.
 * Survives container restarts because /data/jobs is a bind mount.
 */
export class JobStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  async init() {
    await fs.mkdir(this.rootDir, { recursive: true });
  }

  jobPath(id) {
    return path.join(this.rootDir, `${id}.json`);
  }

  // Atomic write: write to a unique temp file then rename over the target.
  // rename() is atomic on the same filesystem, so a reader never observes a
  // half-written / torn file (the cause of the "}lyze" corruption crash-loop).
  async writeJobAtomic(id, job) {
    const finalPath = this.jobPath(id);
    const tmpPath = `${finalPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const body = JSON.stringify(job, null, 2);
    await fs.writeFile(tmpPath, body, "utf8");
    try {
      await fs.rename(tmpPath, finalPath);
    } catch (e) {
      try { await fs.unlink(tmpPath); } catch {}
      throw e;
    }
  }

  async create(id, initial) {
    const job = {
      id,
      status: "queued",
      progress: 0,
      message: "Queued",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      ...initial,
    };
    await this.writeJobAtomic(id, job);
    return job;
  }

  async get(id) {
    try {
      const data = await fs.readFile(this.jobPath(id), "utf8");
      return JSON.parse(data);
    } catch (e) {
      if (e && e.code === "ENOENT") return null;
      // A corrupt/unparseable job file must NEVER crash the server. Treat it as
      // missing so the poll endpoint returns 404 instead of throwing.
      console.warn(`[jobstore] dropping unreadable job ${id}: ${e?.message || e}`);
      return null;
    }
  }

  async update(id, patch) {
    const current = (await this.get(id)) ?? {};
    const next = { ...current, ...patch, updatedAt: Date.now() };
    // Auto-append to recentLogs (ring buffer, 30 entries) whenever message changes.
    // The app polls /jobs/:id and reads recentLogs for a live scrolling log feed.
    if (patch.message && patch.message !== current.message) {
      const logs = Array.isArray(current.recentLogs) ? current.recentLogs.slice() : [];
      logs.push({ ts: Date.now(), msg: String(patch.message) });
      if (logs.length > 30) logs.splice(0, logs.length - 30);
      next.recentLogs = logs;
    }
    await this.writeJobAtomic(id, next);
    return next;
  }

  async list() {
    try {
      const files = await fs.readdir(this.rootDir);
      const out = [];
      for (const f of files) {
        if (!f.endsWith(".json")) continue;
        // Sidecar diagnostic files (e.g. "{jobId}-beat-log.json" from the
        // Twelve Labs beat log, Step 12) live in the same JOBS_DIR but are NOT
        // job records — skip by suffix, then double-check with an `id` field
        // validation below so any future sidecar file can't corrupt /history.
        if (f.endsWith("-beat-log.json")) continue;
        try {
          const parsed = JSON.parse(await fs.readFile(path.join(this.rootDir, f), "utf8"));
          if (!parsed || typeof parsed.id !== "string") continue;
          out.push(parsed);
        } catch {
          // skip corrupt
        }
      }
      out.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
      return out;
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
}

