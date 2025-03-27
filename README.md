# a-sync

A-SYNC: API sync engine with persistent client-side storage.

Tired of switching to new ORM libraries just to support API sync? Bring your own database and APIs—this is the perfect library for you!

## Setup

```typescript
// store/index.ts
import { init } from "a-sync/core";

export const store = init({ appName: "yourApp" });
```

## Define your data and specify how to set and retrieve it via APIs.

```typescript
import { store } from "store";
// Usage example:
interface IUser {
  id: string;
  name: string;
}

// Define your data and set up GET and SET APIs.
// 'userProfile' sample
store
  .define<"userProfile", IUser>({ key: "userProfile" })
  .get(async (args) => {
    // you can call as many APIs as you want to fetch data and mutate 'userProfile'
    const response = await fetch(`/api/${args.id}`);
    return response.json();
  })
  .set(async (args) => {
    // you can call as many APIs as you want to fetch data and mutate 'userProfile' and save it
    const response = await fetch(`/api/user`, {
      method: "POST",
      body: JSON.stringify(args),
    });
    return response.json();
  })
  .on("error", ({ error, defineKey }) => {
    // handle error
    // defineKey === 'userProfile'
  });
```

## How to use set and get APIs

```typescript
const user = store.getDefined("userProfile");

await user.callSet({ name: "John", id: "123" });

const { data: userProfile, source } = await user.callGet({ id: "123" }); // Async Generator
```

## Deal with Getters

> Read data from an async generator method

```typescript
for await (const { data, source } of user.callGet({ id: "123" })) {
  if (source === "storage") {
    // data === userProfile
  }

  if (source === "api") {
    // data === userProfile
  }
}
```

> Read stored data from LocalForage

```typescript
const { data } = await user.getData({ id: "123" });
```
