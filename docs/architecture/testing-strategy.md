# 🧪 Testing Strategy

## 1. Overview
This document outlines the testing strategy for the portfolio project marketplace. Testing is divided into two primary domains: Backend (NestJS Monolith) and Frontend (Next.js Application).

## 2. Backend Testing Strategy
The backend is the core of the application's business logic and data integrity, requiring rigorous testing.

- **End-to-End (E2E) Tests (Mandatory)**: 
  - Every backend feature must be fully covered by E2E tests. 
  - These tests spin up the entire application module (often integrating with real/test databases like Postgres, ScyllaDB, and Redis) and send HTTP requests or GraphQL queries to the endpoints.
  - They validate the complete flow from routing, authentication, business logic, down to database persistence.
- **Unit Tests**:
  - Required for isolated, reusable functionality or complex algorithmic logic (e.g., pricing calculations, search algorithms, data transformation utils).
  - Mocks should be used sparingly, primarily for external dependencies (e.g., Stripe, Cloudflare).

## 3. Frontend Testing Strategy
The frontend testing focuses on user flows and happy paths.

- **End-to-End (E2E) Tests (Mandatory)**:
  - Critical user journeys and main functionality must be covered using E2E tests (e.g., using Playwright or Cypress).
  - Key flows include: Authentication (Login/Register), Product Search & Filtering, Add to Cart, Checkout flow, and Chat interactions.
- **Unit Tests**:
  - Used selectively for complex frontend logic, custom hooks, or highly reusable UI components.
  - Simple presentational components do not require unit tests unless they contain intricate state or interaction logic.

## 4. Running Tests & Optimization

Given that E2E tests spin up real infrastructure and the NestJS application context, running the entire suite can be slow. To optimize the development loop, you should run individual test files while working on specific features.

**Backend:**
- To run a specific E2E test file: `pnpm --filter api test:e2e path/to/your.e2e-spec.ts`
- To run a specific Unit test file: `pnpm --filter api test path/to/your.spec.ts`

**Frontend:**
- To run a specific Unit test file: `pnpm --filter web test path/to/your.test.ts`
- To run Playwright tests in UI mode for selective execution: `pnpm --filter web test:e2e --ui`

## 5. Spec-Driven Development Workflow
1. **Feature Specification**: Define the business logic and UI/UX in a feature spec document.
2. **E2E Test Generation**: Write the E2E tests based on the unambiguous feature specification.
3. **Unit Test Generation**: Write unit tests for complex sub-components.
4. **Code Implementation**: Write or fix the application code until all tests pass.
5. **Live Verification**: After tests pass, run the app and check the original repro (see [Agent Workflow](agent-workflow.md)).

## 6. Agent Rules
Environment rules (infra, ports, test DB migration), the autonomous verification loop and per-file test commands for agents are in [Agent Workflow](agent-workflow.md).
