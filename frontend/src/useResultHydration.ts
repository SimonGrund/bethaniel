// ── Lazy result hydration ──
// Queue snapshots carry only resultMeta counts; the full TaskResult (chapter
// texts + corrections) is fetched on demand and merged into the store via
// setTaskResults. One hook covers every case:
//   - boot / page refresh: first terminal task of a job triggers a bulk
//     per-job fetch of all its results
//   - Former Runs: a job becomes eligible when its card is opened
//   - live run: after the initial bulk fetch, newly-finished chapters are
//     fetched individually (no O(n²) re-transfer of the whole job)

import { useEffect, useRef, useState } from "react";
import { useStore } from "./store";
import { fetchJobResults, fetchTaskResult } from "./api";
import type { TaskState, TaskStatus } from "./types";

const TERMINAL = new Set<TaskStatus>(["done", "error", "cancelled"]);

export function useResultHydration(
  tasks: Record<string, TaskState>,
  eligibleJobIds: "all" | Set<string>,
): Set<string> {
  const setTaskResults = useStore((s) => s.setTaskResults);
  const inflightJobs = useRef(new Set<string>());
  const inflightTasks = useRef(new Set<string>());
  // Jobs that have completed a bulk fetch at least once.
  const bulkFetched = useRef(new Set<string>());
  const [pendingJobs, setPendingJobs] = useState<Set<string>>(new Set());

  useEffect(() => {
    const needyByJob = new Map<string, string[]>();
    for (const [tid, t] of Object.entries(tasks)) {
      const jid = t.jobId ?? "legacy";
      if (eligibleJobIds !== "all" && !eligibleJobIds.has(jid)) continue;
      if (!TERMINAL.has(t.status) || t.result || !t.resultMeta) continue;
      const list = needyByJob.get(jid) ?? [];
      list.push(tid);
      needyByJob.set(jid, list);
    }

    for (const [jid, tids] of needyByJob) {
      if (!bulkFetched.current.has(jid)) {
        if (inflightJobs.current.has(jid)) continue;
        inflightJobs.current.add(jid);
        setPendingJobs((p) => new Set(p).add(jid));
        fetchJobResults(jid)
          .then((map) => {
            bulkFetched.current.add(jid);
            setTaskResults(map);
          })
          // Not marked bulkFetched on failure — retried on the next snapshot.
          .catch(() => {})
          .finally(() => {
            inflightJobs.current.delete(jid);
            setPendingJobs((p) => {
              const n = new Set(p);
              n.delete(jid);
              return n;
            });
          });
      } else {
        for (const tid of tids) {
          if (inflightTasks.current.has(tid)) continue;
          inflightTasks.current.add(tid);
          fetchTaskResult(tid)
            .then((r) => {
              if (r) setTaskResults({ [tid]: r });
            })
            .catch(() => {})
            .finally(() => inflightTasks.current.delete(tid));
        }
      }
    }
  }, [tasks, eligibleJobIds, setTaskResults]);

  return pendingJobs;
}
