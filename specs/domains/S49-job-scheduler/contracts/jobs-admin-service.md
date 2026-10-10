# Contract: `JobsAdminService` (for S01's admin routes; DTOs only, never rows)

| Method | Result |
|---|---|
| `listJobs({ status?, type?, shopId? }, { limit?, cursor? })` | `{ items: JobDto[], nextCursor?: string }`; limit 1–100 (default 50, clamped); order `createdAt DESC, id DESC`; opaque cursor, tampering gives `InvalidCursorError` |
| `getStats()` | per type: counts by status, oldest due `runAt`, lag in seconds |
| `retryDead(jobId, actorId)` | `{outcome:'RETRIED'}`, `{outcome:'CONFLICT', status}` or `{outcome:'NOT_FOUND'}`; writes an audit log line (job id, previous status, actor) |
| `cancel(jobId)` | same result type as `JobsService.cancel` |
| `listSchedules()` | `ScheduleDto[]` |
| `setScheduleEnabled(name, enabled)` | `boolean`; enabling recomputes `nextFireAt` from now |

`JobDto`: `id, type, status, runAt, attempts, maxAttempts, shopId, lastError, createdAt, finishedAt`. No payload field. ADMIN-role enforcement is S01's job (X.5: infrastructure does not import identity).
