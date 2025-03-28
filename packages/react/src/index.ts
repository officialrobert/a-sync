import {
  useQuery,
  useMutation,
  useQueryClient,
  UseQueryOptions,
  UseMutationOptions,
  QueryKey,
} from "@tanstack/react-query";
import type { SyncDefineApi } from "@a-sync/core";

function useAsyncQuery<
  TReturn extends Record<string, any>,
  TArgs extends Record<string, any>
>(
  api: SyncDefineApi<TReturn, TArgs>,
  args: Partial<TArgs>,
  options?: Omit<
    UseQueryOptions<TReturn, Error, TReturn>,
    "queryKey" | "queryFn"
  >,
  mutationOptions?: Omit<
    UseMutationOptions<TReturn, Error, Partial<TArgs>, unknown>,
    "mutationFn"
  >
) {
  const queryClient = useQueryClient();
  const queryKey = [api.key, args] as const;

  // Query hook for fetching data
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      let latestData: TReturn | null = null;

      for await (const result of api.callGet(args)) {
        if (result.data) {
          latestData = result.data;
          if (result.source === "storage") {
            queryClient.setQueryData(queryKey, result.data);
          }
        }
      }

      if (!latestData) {
        throw new Error("No data available");
      }

      return latestData;
    },
    ...options,
  });

  // Mutation hook for updating data
  const mutation = useMutation({
    mutationFn: async (mutateArgs: Partial<TArgs>) => {
      const result = await api.callSet(mutateArgs);
      if (!result.data) {
        throw new Error("Failed to update data");
      }
      return result.data;
    },
    onSuccess: (data) => {
      queryClient.setQueryData(queryKey, data);
      mutationOptions?.onSuccess?.(data, args, undefined);
    },
    onError: (error, variables, context) => {
      mutationOptions?.onError?.(error, variables, context);
    },
    onMutate: async (variables) => {
      // Cancel outgoing refetches
      await queryClient.cancelQueries({ queryKey: queryKey as QueryKey });

      // Snapshot current value
      const previousData = queryClient.getQueryData<TReturn>(queryKey);

      // Optimistically update cache
      if (previousData) {
        queryClient.setQueryData(queryKey, {
          ...previousData,
          ...variables,
        });
      }

      mutationOptions?.onMutate?.(variables);
      return { previousData };
    },
    onSettled: (data, error, variables, context) => {
      queryClient.invalidateQueries({ queryKey: queryKey as QueryKey });
      mutationOptions?.onSettled?.(data, error, variables, context);
    },
    ...mutationOptions,
  });

  return {
    ...query,
    mutation,
  };
}

export { useAsyncQuery };
