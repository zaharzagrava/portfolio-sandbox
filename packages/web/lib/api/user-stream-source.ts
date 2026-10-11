/** Opens the same-origin live stream for the given topics (the one place a W03 stream is created, Constitution VII.1). */
export function openUserStreamSource(topics: readonly string[]): EventSource | null {
  if (typeof EventSource === 'undefined') return null;
  return new EventSource(`/api/streams?topics=${topics.join(',')}`, { withCredentials: true });
}
