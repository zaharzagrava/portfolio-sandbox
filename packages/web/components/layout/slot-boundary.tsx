'use client';

import { Component, type ReactNode } from 'react';

/** A header slot that throws renders nothing in its place; the rest of the header keeps working (AS-04). */
export class SlotBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error(error);
  }

  render() {
    return this.state.failed ? null : this.props.children;
  }
}
