export interface WithRetriesConfig {
  times: number;
  interval: number;
  fallOut?: boolean;
  condition?: (...args: any[]) => boolean;
}

export interface WithRetriesParams extends WithRetriesConfig {
  toTry: (...args: any[]) => any;
}
