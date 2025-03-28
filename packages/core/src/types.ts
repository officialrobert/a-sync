export interface IDefineParams {
  key: string;
  uniqueProperties: string[];
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
  lastRetryAttempt: string;
  key: string; // The original define key
}
