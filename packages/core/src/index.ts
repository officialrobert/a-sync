import * as localForage from "localforage";
import { AYESyncError } from "./error";
import { IDefineParams, PendingItem, SyncEngineParams } from "./types";

type ObjectType = Record<string, any>;
type IsObject<T> = T extends ObjectType ? T : never;
type ValidReturnType = ObjectType;

type GetFunction<
  TReturn extends ValidReturnType,
  TArgs extends ObjectType = ObjectType
> = (args: Partial<TArgs>) => Promise<TReturn>;

type SetFunction<
  TReturn extends ValidReturnType,
  TArgs extends ObjectType = ObjectType
> = (args: Partial<TArgs>) => Promise<TReturn>;

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

export class SyncDefineApi<
  TReturn extends ValidReturnType,
  TArgs extends ObjectType = TReturn
> {
  public key: string;
  private store: LocalForage;
  private getFn?: GetFunction<TReturn, TArgs>;
  private setFn?: SetFunction<TReturn, TArgs>;
  private dataCallbacks: EventCallback<TReturn>[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private apiSetRetries: number = 3;
  private apiCallTimeoutMs: number = 20_000;
  private static PENDING_ITEMS_KEY = "a-sync-pending-items";
  private appName: string;
  private uniqueProperties: string[] = [];

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
    this.uniqueProperties = options?.uniqueProperties ?? [];
  }

  private validateArgs(value: unknown): asserts value is Record<string, any> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AYESyncError(
        "Arguments must be an object type for query parameters"
      );
    }
  }

  private getPendingItemsLocalKey(): string {
    return this.appName + SyncDefineApi.PENDING_ITEMS_KEY;
  }

  get(fn: GetFunction<TReturn, TArgs>): SyncDefineApi<TReturn, TArgs> {
    this.getFn = fn;
    return this;
  }

  set(fn: SetFunction<TReturn, TArgs>): SyncDefineApi<TReturn, TArgs> {
    this.setFn = fn;
    return this;
  }

  on(
    event: "data",
    callback: EventCallback<TReturn>
  ): SyncDefineApi<TReturn, TArgs>;
  on(event: "error", callback: ErrorCallback): SyncDefineApi<TReturn, TArgs>;
  on(
    event: "data" | "error",
    callback: EventCallback<TReturn> | ErrorCallback
  ): SyncDefineApi<TReturn, TArgs> {
    if (event === "data") {
      this.dataCallbacks.push(callback as EventCallback<TReturn>);
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

  private emitData(data: TReturn, dataKey?: string) {
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
    if (this.uniqueProperties.length === 0) {
      return this.key;
    }

    const uniqueHash = this.uniqueProperties
      .sort((a, b) => a.localeCompare(b))
      .map((prop) => {
        const value = args[prop];
        return typeof value !== "undefined" ? `${prop}:${value}` : null;
      })
      .filter((p) => !!p)
      .join("|");

    return `${this.key}${uniqueHash ? `|${uniqueHash}` : ""}`;
  }

  private isOnline(): boolean {
    return typeof window.navigator !== "undefined" && window.navigator.onLine;
  }

  /**
   * An async generator that yields the data from the API and the storage.
   *
   * @param {IsObject<Partial<TArgs>>} args
   * @returns {AsyncGenerator<{ data: TReturn | null; source: "storage" | "api" }>}
   */
  async *callGet(
    args: IsObject<Partial<TArgs>>
  ): AsyncGenerator<{ data: TReturn | null; source: "storage" | "api" }> {
    if (!this.getFn) {
      throw new AYESyncError("Get function not defined");
    }

    this.validateArgs(args);
    const storageKey = this.generateStorageKey(args);

    try {
      const storedData = await this.store.getItem<TReturn>(storageKey);

      if (typeof storedData !== "undefined" && storedData !== null) {
        this.emitData(storedData, storageKey);
        yield { data: storedData, source: "storage" };
      }

      const data = await this.getFn(args);
      await this.store.setItem(storageKey, data);

      this.emitData(data, storageKey);
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

  /**
   * Call the API set function and optimistically update the data in localForage.
   * If the API call fails, the data will be saved in localForage's pending items.
   *
   * @param {IsObject<Partial<TArgs>>} params
   * @returns   { data: TReturn | null }
   */
  async callSet(
    params: IsObject<Partial<TArgs>>
  ): Promise<{ data: TReturn | null }> {
    if (!this.setFn) {
      throw new AYESyncError("Set function not defined");
    }

    this.validateArgs(params);
    const storageKey = this.generateStorageKey(params);

    try {
      const existingData = await this.store.getItem<TReturn>(storageKey);
      const optimisticData = {
        ...(typeof existingData === "object" ? existingData : {}),
        ...params,
      } as TReturn;

      if (this.isOnline()) {
        await this.store.setItem(storageKey, optimisticData);
      }

      const result = await this.executeWithTimeout(this.setFn(params));
      await this.store.setItem(storageKey, result);
      this.emitData(result, storageKey);

      return { data: result };
    } catch (error) {
      if (!this.apiSetRetries || this.apiSetRetries < 0) {
        this.emitError(
          new AYESyncError(
            error instanceof Error ? error?.message : "callSet error"
          ),
          storageKey
        );
        await this.savePendingItem(params, storageKey);
      } else {
        for (let i = 0; i < this.apiSetRetries; i++) {
          try {
            const result = await this.executeWithTimeout(this.setFn(params));
            await this.store.setItem(storageKey, result);
            this.emitData(result, storageKey);

            return { data: result };
          } catch (error) {
            if (i === this.apiSetRetries - 1) {
              this.emitError(
                new AYESyncError(
                  error instanceof Error ? error?.message : "callSet error"
                ),
                storageKey
              );
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
   * @param {IsObject<Partial<TArgs>>} args
   * @returns { data: U | null }
   */
  async getData(
    args: IsObject<Partial<TArgs>>
  ): Promise<{ data: TReturn | null | undefined; error?: Error }> {
    this.validateArgs(args);
    const storageKey = this.generateStorageKey(args);

    try {
      const storedData = await this.store.getItem<TReturn>(storageKey);

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
    params: Partial<TArgs>,
    dataKey: string
  ): Promise<void> {
    try {
      const pendingItems =
        (await this.store.getItem<PendingItem<TArgs>[]>(
          this.getPendingItemsLocalKey()
        )) || [];

      const pendingItem: PendingItem<TArgs> = {
        params,
        dataKey,
        maxRetryCount: this.apiSetRetries,
        lastRetryAttempt: new Date().toISOString(),
        key: this.key,
      };

      pendingItems.push(pendingItem);
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
        (await this.store.getItem<PendingItem<TArgs>[]>(
          this.getPendingItemsLocalKey()
        )) || [];
      const currentItems = pendingItems.filter((item) => item.key === this.key);

      for (const item of currentItems) {
        try {
          const result = await this.setFn?.(item.params as TArgs);

          if (typeof result !== "undefined" && !!item?.dataKey) {
            await this.store.setItem(item.dataKey, result);
            await this.removePendingItem(item.dataKey);
          }
        } catch (error) {
          if (
            !item?.maxRetryCount ||
            item?.maxRetryCount <= 0 ||
            typeof item?.maxRetryCount !== "number"
          ) {
            await this.removePendingItem(item.dataKey);
          } else if (item?.dataKey?.length > 0) {
            item.maxRetryCount -= 1;
            item.lastRetryAttempt = new Date().toISOString();
            await this.savePendingItem(item.params as TArgs, item.dataKey);
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

  /**
   * Get the localForage database instance.
   *
   * @returns  {LocalForage}
   */
  getDB(): LocalForage {
    return this.store;
  }

  /**
   * Check if the localForage database is ready.
   *
   * @returns  {boolean}
   */
  isLocalDbReady(): boolean {
    return this.localDbReady;
  }

  /**
   * Returns a promise that resolves when the localForage database is ready.
   *
   * @returns  {Promise<boolean>}
   */
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

  define<
    K extends string,
    TReturn extends ObjectType,
    TArgs extends ObjectType = TReturn
  >(
    params: IDefineParams & { key: K }
  ): SyncDefineApi<TReturn, TArgs> &
    SyncEngineApi<TypeMap & Record<K, TReturn>> {
    const uniqueProperties = (params.uniqueProperties || []).filter(
      (p) => typeof p === "string" && p?.length > 0
    );

    if (!uniqueProperties?.length) {
      throw new AYESyncError("'uniqueProperties' must be an array of strings");
    }

    const definition = new SyncDefineApi<TReturn, TArgs>(
      params.key,
      this.store,
      this.appName,
      params
    );

    this.definedKeysMap[params.key as keyof TypeMap] = definition as any;
    this.definedKeys.push(params.key);
    return definition as any;
  }

  getDefined<K extends keyof TypeMap>(key: K): SyncDefineApi<TypeMap[K], any> {
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
export { AYESyncError } from "./error";
