// Count durable execution records rather than SDK workers or notification
// promises. One business action can otherwise appear in several runtime maps.
export function createTaskActivityReader(db) {
  const query = `WITH active_tasks AS (
    SELECT session_id,status FROM work_tasks
      WHERE status IN ('running','queued') AND deleted_at IS NULL
    UNION ALL
    SELECT CASE WHEN json_valid(snapshot_json)
      THEN CASE WHEN json_type(snapshot_json,'$.targetSessionId')='text'
        THEN json_extract(snapshot_json,'$.targetSessionId') END END AS session_id,status
      FROM task_runs WHERE status IN ('running','queued')
  ) SELECT session_id,
    SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS runningTaskCount,
    SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queuedTaskCount
    FROM active_tasks WHERE session_id IS NOT NULL`;
  const all = db.prepare(`${query} GROUP BY session_id`);
  const one = db.prepare(`${query} AND session_id=? GROUP BY session_id`);
  return sessionId => new Map((sessionId === undefined ? all.all() : one.all(sessionId))
    .map(row => [row.session_id, { runningTaskCount: row.runningTaskCount, queuedTaskCount: row.queuedTaskCount }]));
}
