/**
 * Public entry point of the `seller-onboarding` domain (constitution X.4): the three modules, the extraction service
 * (`process`, `routeToReview`) and the extraction command's message schema. Nothing else leaves the domain.
 */
export {
  OnboardingExtractionModule,
  OnboardingLocalExtractorModule,
  OnboardingModule,
  OnboardingProjectorModule,
  OnboardingWorkerModule,
} from './onboarding.module';
export { ExtractionService } from './application/extraction.service';
export {
  EXTRACT_DOCUMENT_TASK,
  EXTRACTION_QUEUE,
  extractDocumentBody,
} from './application/onboarding-documents.service';
export {
  OnboardingError,
  ONBOARDING_PROBLEMS,
  type OnboardingProblemCode,
} from './domain/errors';
export { onboardingRatePolicies } from './rate-limit-policies';
