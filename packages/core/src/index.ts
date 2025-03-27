import * as localForage from "localforage";
import { AYESyncError } from "./error";
import { IDefineParams, SyncEngineParams } from "./types";

type ObjectType = Record<string, any>;
type IsObject<T> = T extends ObjectType ? T : never;
type GetFunction<T extends ObjectType> = (args: Partial<T>) => Promise<T>;
type SetFunction<T extends ObjectType> = (data: Partial<T>) => Promise<T>;
type EventCallback<T> = (data: T) => void;
type ErrorCallback = (error: Error) => void;

export class SyncDefineApi<T extends ObjectType> {
  private key: string;
  private store: LocalForage;
  private getFn?: GetFunction<T>;
  private setFn?: SetFunction<T>;
  private dataCallbacks: EventCallback<T>[] = [];
  private errorCallbacks: ErrorCallback[] = [];
  private retryCount: number = 0;
  private apiSetRetries: number = 3;
  private apiCallTimeoutMs: number = 5000;

  constructor(key: string, store: LocalForage, options?: IDefineParams) {
    this.key = key;
    this.store = store;
    this.apiSetRetries = options?.apiSetRetries ?? 3;
    this.apiCallTimeoutMs = options?.apiCallTimeoutMs ?? 5000;
  }

  private validateObject(value: unknown): asserts value is ObjectType {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new AYESyncError(
        "Arguments must be an object type, not an array or primitive"
      );
    }
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

  private emitData(data: T) {
    this.dataCallbacks.forEach((callback) => callback(data));
  }

  private emitError(error: Error) {
    this.errorCallbacks.forEach((callback) => callback(error));
  }

  async callGet(args: IsObject<Partial<T>>): Promise<{ data: T | null }> {
    if (!this.getFn) {
      throw new AYESyncError("Get function not defined");
    }

    this.validateObject(args);

    try {
      // Try to get from store first
      const storedData = await this.store.getItem<T>(this.key);

      if (storedData) {
        this.emitData(storedData);
        return { data: storedData };
      }

      // Call API
      const data = await this.executeWithTimeout(this.getFn(args));

      // Store the result
      await this.store.setItem(this.key, data);

      this.emitData(data);
      return { data };
    } catch (error) {
      this.emitError(error as Error);
      return { data: null };
    }
  }

  async callSet(data: IsObject<Partial<T>>): Promise<{ data: T | null }> {
    if (!this.setFn) {
      throw new AYESyncError("Set function not defined");
    }

    this.validateObject(data);

    try {
      const result = await this.executeWithTimeout(this.setFn(data));

      // Store the result
      await this.store.setItem(this.key, result);

      this.emitData(result);
      this.retryCount = 0;
      return { data: result };
    } catch (error) {
      this.emitError(error as Error);

      // Handle offline/error retry logic
      if (this.retryCount < this.apiSetRetries) {
        this.retryCount++;
        // Store pending operation
        await this.store.setItem(`${this.key}_pending`, {
          data,
          retryCount: this.retryCount,
        });

        // Could implement retry mechanism here
        return this.callSet(data);
      }

      return { data: null };
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

  constructor(params: SyncEngineParams) {
    this.appName = params.appName;
    this.store = localForage.createInstance({
      name: this.appName,
    });
  }

  define<K extends string, T extends ObjectType>(
    params: IDefineParams & { key: K }
  ): SyncDefineApi<T> & SyncEngineApi<TypeMap & Record<K, T>> {
    const definition = new SyncDefineApi<T>(params.key, this.store, params);

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
}

export const init = (params: SyncEngineParams): SyncEngineApi => {
  return new SyncEngineApi(params);
};

export { IDefineParams, SyncEngineParams } from "./types";
