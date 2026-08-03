-- Per-day counter of "plan cap hit" events: how many times a worker start was
-- refused because the concurrent-agents limit was reached. Ventas queries the
-- aggregate to size upgrade conversations; one row per calendar day (UTC).

CREATE TABLE plan_cap_hits (
    date       TEXT PRIMARY KEY,
    count      INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now', 'subsec'))
);
