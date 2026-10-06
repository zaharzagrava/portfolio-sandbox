use std::time::{Duration, Instant};

/// Fixed-window counter, scoped to a single connection. Deliberately simple:
/// this bounds spam from one socket, it does not try to be a distributed
/// per-user limiter across connections/instances - that would need a shared
/// store (e.g. Redis) and isn't worth the complexity for a portfolio-scale
/// deployment. A production system serving real abuse traffic would want
/// that on top of this.
pub struct RateLimiter {
    window_start: Instant,
    count: u32,
    limit: u32,
    window: Duration,
}

impl RateLimiter {
    pub fn new(limit: u32, window: Duration) -> Self {
        Self {
            window_start: Instant::now(),
            count: 0,
            limit,
            window,
        }
    }

    /// Returns true if the action is allowed under the current window.
    pub fn check(&mut self) -> bool {
        let now = Instant::now();
        if now.duration_since(self.window_start) > self.window {
            self.window_start = now;
            self.count = 0;
        }

        if self.count >= self.limit {
            false
        } else {
            self.count += 1;
            true
        }
    }
}
