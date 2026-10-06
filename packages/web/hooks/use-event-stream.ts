'use client';

import { useEffect } from 'react';
import { createEventStream } from '@/lib/api/sse';

export function useEventStream(
  topics: string[],
  types: string[],
  onEvent: (topic: string, type: string, data: unknown) => void
) {
  useEffect(() => {
    if (!topics.length || !types.length) return;

    const stream = createEventStream(topics, types, onEvent);

    return () => {
      stream.close();
    };
  }, [topics.join(','), types.join(','), onEvent]);
}
