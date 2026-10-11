'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * Contains a rendering fault of one optional section (W02 FR-161): the section shows `fallback` (nothing by default) and
 * the rest of the page stays. The error is reported by digest-free name only; no message reaches the page.
 */
export class SectionBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, _info: ErrorInfo) {
    void _info;
    console.error(`section failed: ${error.name}`);
  }

  render() {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
