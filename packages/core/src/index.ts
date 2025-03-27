import * as localForage from "localforage";
import { AYESyncError } from "./error";
import { IDefineParams, PendingItem, SyncEngineParams } from "./types";

type ObjectType = Record<string, any>;
type IsObject<T> = T extends ObjectType ? T : never;
type GetFunction<T extends ObjectType> = (args: Partial<T>) => Promise<T>;
type SetFunction<T extends ObjectType> = (data: Partial<T>) => Promise<T>;
type EventCallback<T> = (params: {
  data: T;
  defineKey: string;
  dataKey?: string;
}) => void;
type ErrorCallback = (params: {
  error: Error;
  defineKey: string;
  dataKey?: string;
}) => void;

export class SyncDefineApi<T extends ObjectType> {
  private key: string;
  private store: LocalForage;
  private getFn?: GetFunction<T>;
  private setFn?: SetFunction<T>;
  private dataCallbacks: EventCallback<T>[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private apiSetRetries: number = 3;
  private apiCallTimeoutMs: number = 20_000; // 20 seconds default api timeout
  private static PENDING_ITEMS_KEY = "a-sync-pending-items";
  private appName: string;

  constructor(
    key: string,
    store: LocalForage,
    appName: string,
    options?: IDefineParams
  ) {
    this.key = key;
    this.store = store;
    this.apiSetRetries = options?.apiSetRetries ?? 3;
    this.apiCallTimeoutMs = options?.apiCallTimeoutMs ?? 20_000;
    this.appName = appName;
  }

  private validateObject(value: unknown): asserts value is ObjectType {
    // must check if object is empty or not
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AYESyncError(
        "Arguments must be an object type, not an array or primitive"
      );
    }
  }

  private getPendingItemsLocalKey(): string {
    return this.appName + SyncDefineApi.PENDING_ITEMS_KEY;
  }

  get(fn: GetFunction<T>): SyncDefineApi<T> {
    this.getFn = fn;
    return this;
  }

  set(fn: SetFunction<T>): SyncDefineApi<T> {
    this.setFn = fn;
    return this;
  }

  on(event: "data", callback: EventCallback<T>): SyncDefineApi<T>;
  on(event: "error", callback: ErrorCallback): SyncDefineApi<T>;
  on(
    event: "data" | "error",
    callback: EventCallback<T> | ErrorCallback
  ): SyncDefineApi<T> {
    if (event === "data") {
      this.dataCallbacks.push(callback as EventCallback<T>);
    } else {
      this.errorCallbacks.push(callback as ErrorCallback);
    }
    return this;
  }

  private async executeWithTimeout<U>(promise: Promise<U>): Promise<U> {
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(new AYESyncError("API call timeout")),
        this.apiCallTimeoutMs
      );
    });

    return Promise.race([promise, timeout]);
  }

  private emitData(data: T, dataKey?: string) {
    this.dataCallbacks.forEach((callback) =>
      callback({ data, dataKey, defineKey: this.key })
    );
  }

  private emitError(error: Error | AYESyncError, dataKey?: string) {
    this.errorCallbacks.forEach((callback) =>
      callback({ error, dataKey, defineKey: this.key })
    );
  }

  private generateStorageKey(args: ObjectType): string {
    // Create a stable hash from the arguments
    const argsHash = Object.entries(args)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => `${key}:${value}`)
      .join("|");

    return `${this.key}${argsHash ? `|${argsHash}` : ""}`;
  }

  private isOnline(): boolean {
    return typeof window.navigator !== "undefined" && window.navigator.onLine;
  }

  async *callGet<U extends T = T>(
    args: IsObject<Partial<U>>
  ): AsyncGenerator<{ data: U | null; source: "storage" | "api" }> {
    if (!this.getFn) {
      throw new AYESyncError("Get function not defined");
    }

    this.validateObject(args);

    const storageKey = this.generateStorageKey(args);

    try {
      // Try to get from store first using the unique key
      const storedData = await this.store.getItem<U>(storageKey);

      if (storedData) {
        this.emitData(storedData as T, storageKey);
        yield { data: storedData, source: "storage" };
      }

      // Call API
      const data = (await this.getFn(args as Partial<T>)) as U;

      // Store the result with the unique key
      await this.store.setItem(storageKey, data);

      this.emitData(data as T, storageKey);
      yield { data, source: "api" };
    } catch (error) {
      this.emitError(
        new AYESyncError(
          error instanceof Error ? error?.message : "callGet error"
        ),
        storageKey
      );

      yield { data: null, source: "api" };
    }
  }

  async callSet<U extends T = T>(
    params: IsObject<Partial<U>>
  ): Promise<{ data: U | null }> {
    if (!this.setFn) {
      throw new AYESyncError("Set function not defined");
    }

    this.validateObject(params);
    const storageKey = this.generateStorageKey(params);

    try {
      // Get existing data if any
      const existingData = await this.store.getItem<U>(storageKey);
      // Optimistically update storage with new data
      const optimisticData = {
        ...(existingData || {}),
        ...params,
      } as U;

      if (this.isOnline()) {
        await this.store.setItem(storageKey, optimisticData);
      }

      const result = (await this.executeWithTimeout(
        this.setFn(params as Partial<T>)
      )) as U;

      await this.store.setItem(storageKey, result);

      this.emitData(result as T, storageKey);

      return { data: result };
    } catch (error) {
      if (!this.apiSetRetries || this.apiSetRetries < 0) {
        this.emitError(
          new AYESyncError(
            error instanceof Error ? error?.message : "callSet error"
          ),
          storageKey
        );

        // keep track of all pending items
        await this.savePendingItem(params, storageKey);
      } else {
        for (let i = 0; i < this.apiSetRetries; i++) {
          try {
            const result = (await this.executeWithTimeout(
              this.setFn(params as Partial<T>)
            )) as U;

            // Store the result with the unique key
            await this.store.setItem(storageKey, result);

            this.emitData(result as T, storageKey);

            break;
          } catch (error) {
            if (i === this.apiSetRetries - 1) {
              this.emitError(
                new AYESyncError(
                  error instanceof Error ? error?.message : "callSet error"
                ),
                storageKey
              );

              // keep track of all pending items
              await this.savePendingItem(params, storageKey);
            }
          }
        }
      }

      return { data: null };
    }
  }

  /**
   * Fetch most recent data from localForage
   *
   * @param {IsObject<Partial<U>>} args
   * @returns { data: U | null }
   */
  async getData<U extends T = T>(
    args: IsObject<Partial<U>>
  ): Promise<{ data: U | null | undefined; error?: Error }> {
    this.validateObject(args);
    const storageKey = this.generateStorageKey(args);

    try {
      const storedData = await this.store.getItem<U>(storageKey);

      if (storedData) {
        return { data: storedData };
      }

      return { data: undefined };
    } catch (error) {
      this.emitError(
        new AYESyncError(
          error instanceof Error
            ? error?.message
            : "Error while getting data from localForage"
        )
      );

      return { data: null, ...(error instanceof Error ? { error } : {}) };
    }
  }

  private async savePendingItem(
    params: Partial<T>,
    dataKey: string
  ): Promise<void> {
    try {
      // Get existing pending items
      const pendingItems =
        (await this.store.getItem<PendingItem<any>[]>(
          this.getPendingItemsLocalKey()
        )) || [];

      const pendingItem: PendingItem<T> = {
        params,
        dataKey,
        maxRetryCount: this.apiSetRetries,
        lastRetryAttempt: new Date().toISOString(),
        key: this.key,
      };

      // Add new pending item
      pendingItems.push(pendingItem);

      // Save updated pending items
      await this.store.setItem(this.getPendingItemsLocalKey(), pendingItems);
    } catch (error) {
      this.emitError(
        new AYESyncError(`Failed to save pending item: ${dataKey}`)
      );
    }
  }

  private async removePendingItem(dataKey: string): Promise<void> {
    try {
      const pendingItems =
        (await this.store.getItem<PendingItem<any>[]>(
          this.getPendingItemsLocalKey()
        )) || [];
      const updatedItems = pendingItems.filter(
        (item) => item.dataKey !== dataKey
      );
      await this.store.setItem(this.getPendingItemsLocalKey(), updatedItems);
    } catch (error) {
      this.emitError(
        new AYESyncError(`Failed to remove pending item: ${dataKey}`)
      );
    }
  }

  async retryPendingItems(): Promise<void> {
    try {
      const pendingItems =
        (await this.store.getItem<PendingItem<any>[]>(
          this.getPendingItemsLocalKey()
        )) || [];
      const currentItems = pendingItems.filter((item) => item.key === this.key);

      for (const item of currentItems) {
        try {
          const result = await this.setFn?.(item.params as Partial<T>);

          if (typeof result !== "undefined") {
            await this.store.setItem(item.dataKey, result);
            await this.removePendingItem(item.dataKey);
          }
        } catch (error) {
          if (
            !item?.maxRetryCount ||
            // Skip this item if max retries reached
            item?.maxRetryCount <= 0 ||
            // or someone manually updated 'maxRetryCount' value
            typeof item?.maxRetryCount !== "number"
          ) {
            await this.removePendingItem(item.dataKey);
          } else {
            item.maxRetryCount -= 1;
            item.lastRetryAttempt = new Date().toISOString();
            await this.savePendingItem(item.params, item.dataKey);
          }
        }
      }
    } catch (error) {
      this.emitError(
        new AYESyncError(
          `Failed to retry pending items from ${this.key}: ${
            error instanceof Error ? error?.message : ""
          }`
        )
      );
    }
  }
}

export class SyncEngineApi<TypeMap extends Record<string, ObjectType> = {}> {
  private appName: string;
  definedKeys: string[] = [];
  private definedKeysMap: {
    [K in keyof TypeMap]: SyncDefineApi<TypeMap[K]>;
  } = {} as any;
  private store: LocalForage;
  private localDbReady: boolean = false;

  constructor(params: SyncEngineParams) {
    this.appName = params.appName;
    this.store = localForage.createInstance({
      name: this.appName,
    });
    this.setupOnlineListener();
  }

  isLocalDbReady(): boolean {
    return this.localDbReady;
  }

  waitForLocalDbReady(): Promise<boolean> {
    return new Promise((resolve) => {
      if (!this.store) {
        return resolve(false);
      }

      this.store
        .ready()
        .then(() => {
          this.localDbReady = true;
          return resolve(true);
        })
        .catch(() => {
          return resolve(false);
        });
    });
  }

  define<K extends string, T extends ObjectType>(
    params: IDefineParams & { key: K }
  ): SyncDefineApi<T> & SyncEngineApi<TypeMap & Record<K, T>> {
    const definition = new SyncDefineApi<T>(
      params.key,
      this.store,
      this.appName,
      params
    );

    this.definedKeysMap[params.key as keyof TypeMap] = definition as any;
    this.definedKeys.push(params.key);
    return definition as any;
  }

  getDefined<K extends keyof TypeMap>(key: K): SyncDefineApi<TypeMap[K]> {
    const definition = this.definedKeysMap[key];

    if (!definition) {
      throw new AYESyncError(`Key ${key?.toString()} not defined`);
    }

    return definition;
  }

  destroy(): void {
    window.removeEventListener("online", this.retryAllPendingItems);
  }

  async retryAllPendingItems(): Promise<void> {
    for (const key of this.definedKeys) {
      const api = this.getDefined(key);
      await api.retryPendingItems();
    }
  }

  private setupOnlineListener(): void {
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.retryAllPendingItems);
    }
  }
}

export const init = (params: SyncEngineParams): SyncEngineApi => {
  return new SyncEngineApi(params);
};

export { IDefineParams, SyncEngineParams } from "./types";
