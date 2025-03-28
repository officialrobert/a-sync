# @a-sync/react

React hooks for @a-sync/core with React Query integration.

```tsx
// 1. Set up React Query provider
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <YourApp />
    </QueryClientProvider>
  );
}

// 2. Define your data types and API
interface IUser {
  id: string;
  name: string;
}

interface IUserArgs {
  id: string;
  name?: string;
}

// 3. Configure store and API as shown in @a-sync/core docs
const userApi = store
  .define<"userProfile", IUser, IUserArgs>({
    key: "userProfile",
    uniqueProperties: ["id"],
  })
  .get(async (args) => {
    const response = await fetch(`/api/users/${args.id}`);
    return response.json();
  })
  .set(async (args) => {
    const response = await fetch(`/api/users/${args.id}`, {
      method: "PATCH",
      body: JSON.stringify(args),
    });
    return response.json();
  });
```

```tsx
import { useAsyncQuery } from "@a-sync/react";
import { userApi } from "./api";

function UserProfile({ userId }: { userId: string }) {
  const {
    data, // IUser | undefined
    isLoading,
    error,
    mutation,
  } = useAsyncQuery(
    userApi,
    { id: userId },
    {
      // optional
      refetchOnWindowFocus: false,
    },
    {
      // optional
      onSuccess: (data) => {
        console.log("Update successful:", data);
      },
      onError: (error) => {
        console.error("Update failed:", error);
      },
    }
  );

  // Handle loading state
  if (isLoading) return <div>Loading...</div>;

  // Handle error state
  if (error) return <div>Error: {error.message}</div>;

  const handleMutation = () => {
    mutation.mutate({ id: userId, name: "New Name" });
  };

  return (
    <div>
      <h1>{data.name}</h1>
      <button onClick={handleMutation} disabled={mutation.isLoading}>
        {mutation.isLoading ? "Updating..." : "Update Name"}
      </button>
    </div>
  );
}
```
