export interface ModerationResult {
  name: string;
  confidence: number;
  parentName: string;
}

export enum S3ObjectTags {
  NO_THREATS_FOUND = 'NO_THREATS_FOUND',
  THREATS_FOUND = 'THREATS_FOUND',
  UNSUPPORTED = 'UNSUPPORTED',
  ACCESS_DENIED = 'ACCESS_DENIED',
  FAILED = 'FAILED',
}
