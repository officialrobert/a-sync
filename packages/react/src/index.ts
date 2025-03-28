import { useQuery, UseQueryOptions } from "@tanstack/react-query";
import type { SyncDefineApi } from "@a-sync/core";

function useAsyncQuery<T extends Record<string, any>>(
  api: SyncDefineApi<T>,
  args: Partial<T>,
  options?: Omit<UseQueryOptions<T, Error>, "queryKey" | "queryFn">
) {
  return useQuery({
    queryKey: [api.key, args],
    queryFn: async () => {
      let latestData: T | null = null;

      // Get both storage and API data through the generator
      for await (const result of api.callGet(args)) {
        if (result.data) {
          latestData = result.data;
        }
      }

      if (!latestData) {
        throw new Error("No data available");
      }

      return latestData;
    },
    ...options,
  });
}

export { useAsyncQuery };
