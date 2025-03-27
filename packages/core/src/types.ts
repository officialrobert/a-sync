export interface IDefineParams {
  key: string;
  apiCallTimeoutMs?: number;
  apiSetRetries?: number;
}

export interface SyncEngineParams {
  appName: string;
}

export interface PendingItem<T> {
  params: Partial<T>;
  dataKey: string;
  maxRetryCount: number;
  lastRetryAttempt: number;
  key: string; // The original define key
}
