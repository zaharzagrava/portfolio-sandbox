'use client';

import { useEffect, useRef } from 'react';
import { createEventStream } from '@/lib/api/sse';

export function useEventStream(
  topics: string[],
  types: string[],
  onEvent: (topic: string, type: string, data: unknown) => void
) {
  // The latest handler is read through a ref, so an inline callback does not tear the stream down on every render.
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const topicKey = topics.join(',');
  const typeKey = types.join(',');

  useEffect(() => {
    if (!topicKey || !typeKey) return;

    const stream = createEventStream(topicKey.split(','), typeKey.split(','), (topic, type, data) =>
      handler.current(topic, type, data)
    );

    return () => {
      stream.close();
    };
  }, [topicKey, typeKey]);
}
