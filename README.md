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

const store = init({ appName: "yourApp" });

const userApi = store
  .define<"userProfile", IUser>({ key: "userProfile" })
  .get(async (args) => {
    const response = await fetch(`/api/${args.id}`);
    return response.json();
  });

const settingsApi = store
  .define<"settings", ISettings>({ key: "settings" })
  .get(async (args) => {
    return { theme: "dark" };
  });

const user = store.getDefined("userProfile");

const settings = store.getDefined("settings");

await user.callGet({ id: "123" });
await user.callSet({ name: "John" });
await settings.callSet({ theme: "light" });
```
