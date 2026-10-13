/**
 * The five events `media` writes (S29 FR-080). The definitions live in `domain/media-events.ts` so the repository
 * (infra, also run by the framework-free Lambda) and the application services share them; this path is where the
 * rest of the codebase and the specs look for them.
 */
export * from '../../domain/media-events';
