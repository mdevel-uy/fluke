//! Concurrency semaphore for coding-agent executor spawns.
//!
//! The semaphore is intentionally in-memory. Server restart wipes the
//! runtime state, but any `execution_processes` row left in `queued`
//! status is picked up again on startup and re-fed into the queue by
//! [`ConcurrencySemaphore::recover_queue`]. The DB is the source of
//! truth for what is queued; this struct only tracks which of the
//! queued rows have been handed slots.
//!
//! Only `CodingAgent` runs are gated. Setup scripts, cleanup scripts,
//! archive scripts and dev servers spawn immediately — they finish
//! quickly (setup/cleanup) or don't compete with agent slots at all
//! (dev servers).
//!
//! Limit resolution (checked on every gate check):
//!   1. `AGENT_CONCURRENCY_LIMIT` env var if it parses as a
//!      non-negative integer
//!   2. `Config.agent_concurrency_limit`
//!   3. `0` (unlimited) fallback
//!
//! Reload semantics differ per source:
//!   - `Config.agent_concurrency_limit` is read from a lock on every
//!     check, so an in-place config edit takes effect on the next
//!     spawn or process exit without a restart.
//!   - `AGENT_CONCURRENCY_LIMIT` is read from the process environment,
//!     which is snapshotted at startup. Changing the env var on a
//!     running server does **not** take effect until the server is
//!     restarted (or until the env var is cleared, at which point the
//!     config value wins again).

use std::{
    collections::{HashSet, VecDeque},
    sync::Arc,
};

use tokio::sync::{Mutex, RwLock};
use uuid::Uuid;

use crate::services::config::Config;

pub const AGENT_CONCURRENCY_LIMIT_ENV: &str = "AGENT_CONCURRENCY_LIMIT";

/// A snapshot of semaphore state, safe to send across await points and
/// to serialize for API responses.
#[derive(Debug, Clone)]
pub struct ConcurrencySnapshot {
    /// Configured limit. `0` = unlimited.
    pub limit: u32,
    /// Number of processes currently holding a slot (i.e. running).
    pub used: u32,
    /// Ordered FIFO of execution-process IDs waiting for a slot.
    pub queued: Vec<Uuid>,
}

impl ConcurrencySnapshot {
    /// 1-based position (`1` = next to run) of `id` in the queue, or
    /// `None` if not queued.
    pub fn position_of(&self, id: &Uuid) -> Option<u32> {
        self.queued
            .iter()
            .position(|q| q == id)
            .map(|idx| idx as u32 + 1)
    }
}

#[derive(Debug, Default)]
struct SemaphoreState {
    running: HashSet<Uuid>,
    queue: VecDeque<Uuid>,
}

#[derive(Clone)]
pub struct ConcurrencySemaphore {
    state: Arc<Mutex<SemaphoreState>>,
    config: Arc<RwLock<Config>>,
}

impl ConcurrencySemaphore {
    pub fn new(config: Arc<RwLock<Config>>) -> Self {
        Self {
            state: Arc::new(Mutex::new(SemaphoreState::default())),
            config,
        }
    }

    /// Resolve the effective limit. `0` means unlimited.
    pub async fn effective_limit(&self) -> u32 {
        if let Ok(raw) = std::env::var(AGENT_CONCURRENCY_LIMIT_ENV)
            && let Ok(parsed) = raw.trim().parse::<u32>()
        {
            return parsed;
        }
        self.config.read().await.agent_concurrency_limit
    }

    /// Try to reserve a slot for `id`. Returns `true` if a slot was
    /// granted (caller should proceed to spawn), `false` if the caller
    /// must enqueue instead.
    ///
    /// Callers already known to be running (already in the `running`
    /// set) get `true` back without incrementing again — this makes
    /// [`Self::try_dequeue`] idempotent when it hands a queued ID back
    /// to the caller.
    pub async fn try_acquire(&self, id: Uuid) -> bool {
        let limit = self.effective_limit().await;
        let mut state = self.state.lock().await;
        if state.running.contains(&id) {
            return true;
        }
        if limit == 0 || (state.running.len() as u32) < limit {
            state.running.insert(id);
            true
        } else {
            false
        }
    }

    /// Push `id` onto the FIFO queue. Silently ignores duplicates so
    /// startup recovery can hydrate the queue without worrying about a
    /// double-enqueue.
    pub async fn enqueue(&self, id: Uuid) {
        let mut state = self.state.lock().await;
        if !state.queue.contains(&id) {
            state.queue.push_back(id);
        }
    }

    /// Release the slot held by `id` (called on process exit / stop).
    /// Also removes `id` from the queue if it was there — covers the
    /// case where a queued process is stopped by the user before ever
    /// running.
    pub async fn release(&self, id: &Uuid) {
        let mut state = self.state.lock().await;
        state.running.remove(id);
        state.queue.retain(|q| q != id);
    }

    /// Pop the next waiting ID if a slot is currently free. Reserves
    /// the slot atomically so a concurrent `try_acquire` cannot claim
    /// the same one.
    pub async fn try_dequeue(&self) -> Option<Uuid> {
        let limit = self.effective_limit().await;
        let mut state = self.state.lock().await;
        if limit != 0 && (state.running.len() as u32) >= limit {
            return None;
        }
        let next = state.queue.pop_front()?;
        state.running.insert(next);
        Some(next)
    }

    /// Restore the FIFO queue from a DB-provided list. Idempotent:
    /// duplicates are ignored so it is safe to call multiple times
    /// (e.g. on manual reconciliation).
    pub async fn recover_queue(&self, queued_ids: impl IntoIterator<Item = Uuid>) {
        let mut state = self.state.lock().await;
        for id in queued_ids {
            if !state.queue.contains(&id) && !state.running.contains(&id) {
                state.queue.push_back(id);
            }
        }
    }

    pub async fn snapshot(&self) -> ConcurrencySnapshot {
        let limit = self.effective_limit().await;
        let state = self.state.lock().await;
        ConcurrencySnapshot {
            limit,
            used: state.running.len() as u32,
            queued: state.queue.iter().copied().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::config::Config;

    async fn make(limit: u32) -> ConcurrencySemaphore {
        // SAFETY: tests are single-threaded per #[tokio::test] task, but
        // set_var/remove_var still race with the shared process env; we
        // do not touch AGENT_CONCURRENCY_LIMIT so config wins.
        let mut cfg = Config::default();
        cfg.agent_concurrency_limit = limit;
        let config = Arc::new(RwLock::new(cfg));
        ConcurrencySemaphore::new(config)
    }

    #[tokio::test]
    async fn queues_third_when_limit_two() {
        let sem = make(2).await;
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        let c = Uuid::new_v4();
        assert!(sem.try_acquire(a).await);
        assert!(sem.try_acquire(b).await);
        assert!(!sem.try_acquire(c).await);
        sem.enqueue(c).await;

        let snap = sem.snapshot().await;
        assert_eq!(snap.used, 2);
        assert_eq!(snap.queued, vec![c]);
        assert_eq!(snap.position_of(&c), Some(1));

        // Releasing frees a slot and the queued one can be dequeued.
        sem.release(&a).await;
        let next = sem.try_dequeue().await;
        assert_eq!(next, Some(c));

        let snap = sem.snapshot().await;
        assert_eq!(snap.used, 2);
        assert!(snap.queued.is_empty());
    }

    #[tokio::test]
    async fn zero_means_unlimited() {
        let sem = make(0).await;
        for _ in 0..10 {
            assert!(sem.try_acquire(Uuid::new_v4()).await);
        }
        assert!(sem.try_dequeue().await.is_none());
    }

    #[tokio::test]
    async fn release_of_queued_does_not_underflow() {
        let sem = make(1).await;
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        assert!(sem.try_acquire(a).await);
        assert!(!sem.try_acquire(b).await);
        sem.enqueue(b).await;
        // Cancelling the queued item removes it from the queue without
        // touching the running set.
        sem.release(&b).await;
        let snap = sem.snapshot().await;
        assert_eq!(snap.used, 1);
        assert!(snap.queued.is_empty());
    }

    #[tokio::test]
    async fn recover_queue_hydrates_idempotently() {
        let sem = make(1).await;
        let a = Uuid::new_v4();
        let b = Uuid::new_v4();
        sem.recover_queue([a, b]).await;
        sem.recover_queue([a, b]).await;
        let snap = sem.snapshot().await;
        assert_eq!(snap.queued, vec![a, b]);
    }
}
