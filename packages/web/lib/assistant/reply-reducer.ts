import { newIdempotencyKey } from '@/lib/api/idempotency';

/**
 * The phases of one assistant reply as a pure reducer (W05 FR-053, AS-42, AS-49..AS-52, AS-57, AS-58). The hook owns the IO
 * (the stream, the timers, the cancel call) and only dispatches; impossible combinations (`stopping` while `idle`, text after
 * the terminal event) cannot be represented because the reducer ignores them.
 *
 *   idle --send--> sending --meta--> streaming --text/tool--> streaming
 *   streaming --connectionLost--> reconnecting --event--> streaming
 *   sending|streaming|reconnecting|stopping --done|refusal|error--> ended(outcome)
 *   streaming|reconnecting --stopRequested--> stopping --error CANCELLED--> ended(stopped)
 *   reconnecting --all attempts failed--> ended(lost)        ended --reset|send--> idle|sending
 */

export type ReplyPhase = 'idle' | 'sending' | 'streaming' | 'reconnecting' | 'stopping' | 'ended';
export type ReplyOutcome = 'done' | 'refused' | 'error' | 'stopped' | 'lost';
/** `interrupted`: the reply is gone (the server could not resume it); `unreachable`: every attempt of the 2-minute window failed. */
export type LostReason = 'interrupted' | 'unreachable';
export type ToolStatus = 'running' | 'done' | 'failed';
export type ToolChip = { id: string; name: string; status: ToolStatus };

export type ReplyState = {
  phase: ReplyPhase;
  outcome?: ReplyOutcome;
  lostReason?: LostReason;
  messageId?: string;
  /** The id of the last event applied: the `Last-Event-ID` of a resume. */
  lastEventId?: string;
  text: string;
  tools: ToolChip[];
  errorCode?: string;
  retryAfterMs?: number;
  refusalSource?: 'provider' | 'moderation';
  allowance?: { used: number; limit: number };
  /** The question that started this reply (kept for Try again). */
  question: string;
  idempotencyKey: string;
};

export const initialReply: ReplyState = { phase: 'idle', text: '', tools: [], question: '', idempotencyKey: '' };

export type ReplyAction =
  | { type: 'send'; question: string; idempotencyKey: string }
  /** Re-attach to a running reply after a reload or a Try again (no `Last-Event-ID`: the stream replays from `meta`). */
  | { type: 'attach'; messageId: string; question: string; idempotencyKey: string }
  /** `409 idempotency_in_flight`: the send is still being answered under this key; attach to that reply. */
  | { type: 'attachInFlight'; messageId: string }
  | { type: 'meta'; messageId: string; eventId?: string }
  | { type: 'text'; t: string; eventId?: string }
  | { type: 'tool'; id: string; name: string; status: ToolStatus; eventId?: string }
  | { type: 'done'; allowance?: { used: number; limit: number }; eventId?: string }
  | { type: 'refusal'; category: string; source: 'provider' | 'moderation'; eventId?: string }
  | { type: 'error'; code: string; retryAfterMs?: number; eventId?: string }
  | { type: 'connectionLost' }
  | { type: 'resumed' }
  | { type: 'stopRequested' }
  /** The server did not end the stream within 5 s of the stop: the local read is aborted. */
  | { type: 'localStop' }
  /** The finished answer was read from the history (a `409 generation_finished`, or a resume that found it). */
  | { type: 'fromHistory'; text: string; tools?: ToolChip[] }
  | { type: 'lost'; reason: LostReason }
  | { type: 'reset' };

const RUNNING: ReplyPhase[] = ['sending', 'streaming', 'reconnecting', 'stopping'];
const LIVE: ReplyPhase[] = ['streaming', 'reconnecting', 'stopping'];

/** `<ms>-<seq>` ids compared numerically; ids of another shape never block an event. */
function increases(next: string | undefined, last: string | undefined): boolean {
  if (!next || !last) return true;
  const parse = (id: string) => /^(\d+)-(\d+)$/.exec(id)?.slice(1).map(Number);
  const a = parse(next);
  const b = parse(last);
  if (!a || !b) return true;
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
}

const withEvent = (state: ReplyState, eventId: string | undefined): Pick<ReplyState, 'lastEventId'> => ({ lastEventId: eventId ?? state.lastEventId });

export function replyReducer(state: ReplyState, action: ReplyAction): ReplyState {
  switch (action.type) {
    case 'reset':
      return initialReply;
    case 'send':
      if (state.phase !== 'idle' && state.phase !== 'ended') return state;
      return { ...initialReply, phase: 'sending', question: action.question, idempotencyKey: action.idempotencyKey };
    case 'attach':
      if (state.phase !== 'idle' && !(state.phase === 'ended' && state.outcome === 'lost')) return state;
      return { ...initialReply, phase: 'reconnecting', messageId: action.messageId, question: action.question, idempotencyKey: action.idempotencyKey };
    case 'attachInFlight':
      if (state.phase !== 'sending') return state;
      return { ...state, phase: 'reconnecting', messageId: action.messageId };
    case 'meta':
      if (!RUNNING.includes(state.phase)) return state;
      // The first `meta` gives the reply its identity; a second one is a replay from the start: rebuilt, never doubled.
      return { ...state, phase: state.phase === 'stopping' ? 'stopping' : 'streaming', messageId: action.messageId, text: '', tools: [], lastEventId: action.eventId };
    case 'text':
      if (!LIVE.includes(state.phase) || !increases(action.eventId, state.lastEventId)) return state;
      return { ...state, phase: state.phase === 'reconnecting' ? 'streaming' : state.phase, text: state.text + action.t, ...withEvent(state, action.eventId) };
    case 'tool': {
      if (!LIVE.includes(state.phase) || !increases(action.eventId, state.lastEventId)) return state;
      const chip: ToolChip = { id: action.id, name: action.name, status: action.status };
      const at = state.tools.findIndex((tool) => tool.id === action.id);
      const tools = at < 0 ? [...state.tools, chip] : state.tools.map((tool, index) => (index === at ? chip : tool));
      return { ...state, phase: state.phase === 'reconnecting' ? 'streaming' : state.phase, tools, ...withEvent(state, action.eventId) };
    }
    case 'done':
      if (!RUNNING.includes(state.phase)) return state;
      return { ...state, phase: 'ended', outcome: 'done', ...(action.allowance ? { allowance: action.allowance } : {}), ...withEvent(state, action.eventId) };
    case 'refusal':
      if (!RUNNING.includes(state.phase)) return state;
      // What was already streamed is withdrawn: the declined text must not stay readable. The category is never kept.
      return { ...state, phase: 'ended', outcome: 'refused', text: '', refusalSource: action.source, ...withEvent(state, action.eventId) };
    case 'error':
      if (!RUNNING.includes(state.phase)) return state;
      if (action.code === 'CANCELLED') return { ...state, phase: 'ended', outcome: 'stopped', ...withEvent(state, action.eventId) };
      return {
        ...state,
        phase: 'ended',
        outcome: 'error',
        errorCode: action.code,
        ...(action.retryAfterMs !== undefined ? { retryAfterMs: action.retryAfterMs } : {}),
        ...withEvent(state, action.eventId),
      };
    case 'connectionLost':
      if (state.phase === 'streaming') return { ...state, phase: 'reconnecting' };
      if (state.phase === 'sending') return { ...state, phase: 'ended', outcome: 'lost', lostReason: 'interrupted' };
      return state;
    case 'resumed':
      return state.phase === 'reconnecting' ? { ...state, phase: 'streaming' } : state;
    case 'stopRequested':
      return state.phase === 'streaming' || state.phase === 'reconnecting' ? { ...state, phase: 'stopping' } : state;
    case 'localStop':
      return state.phase === 'stopping' ? { ...state, phase: 'ended', outcome: 'stopped' } : state;
    case 'fromHistory':
      if (!RUNNING.includes(state.phase)) return state;
      return { ...state, phase: 'ended', outcome: 'done', text: action.text, ...(action.tools ? { tools: action.tools } : {}) };
    case 'lost':
      if (!RUNNING.includes(state.phase)) return state;
      return { ...state, phase: 'ended', outcome: 'lost', lostReason: action.reason };
  }
}

/**
 * One `Idempotency-Key` per user action (FR-050, AS-45): the same unsent text sent again after a failure keeps its key (a lost
 * response or a double press never makes a second paid turn); a new text, or a key the server refused as reused, gets a new one.
 */
export function idempotencyKeyFor(previous: { text: string; key: string; refused?: boolean } | undefined, text: string, make: () => string = newIdempotencyKey): string {
  if (previous && !previous.refused && previous.text.trim() === text.trim()) return previous.key;
  return make();
}
