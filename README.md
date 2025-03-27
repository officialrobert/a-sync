# a-sync

A-SYNC: API sync engine with persistent client-side storage.

```typescript
import { init } from "a-sync";

// Usage example:
interface IUser {
  id: string;
  name: string;
}

interface ISettings {
  theme: string;
}

export const store = init({ appName: "yourApp" });

// Define your data and set up GET and SET APIs.
// 'userProfile' sample
store.define<"userProfile", IUser>({ key: "userProfile" }).get(async (args) => {
  const response = await fetch(`/api/${args.id}`);
  return response.json();
});

// 'settings' sample
store.define<"settings", ISettings>({ key: "settings" }).get(async (args) => {
  return { theme: "dark" };
});

const user = store.getDefined("userProfile");

await user.callSet({ name: "John", id: "123" });

const { data: userProfile, source } = await user.callGet({ id: "123" });

const { data: userProfile } = await user.getData({ id: "123" });
```
