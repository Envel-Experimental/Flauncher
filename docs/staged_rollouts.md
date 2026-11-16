# Staged Rollouts

The distribution system supports **gradual rollouts** — a server can be made available to only a percentage of users before a full release.

---

## How It Works

Each server in `distribution.json` can include a `rollout` field:

```json
{
  "id": "my-server",
  "rollout": {
    "percent": 25
  }
}
```

The launcher deterministically gates access based on the user's stable identity (HWID/clientToken).

---

## Gating Logic

```js
// Pseudo-code
const userId = ConfigManager.getClientToken()      // stable HWID or UUID
const hash = sha256(userId + server.id)            // deterministic per user+server
const bucket = parseInt(hash.slice(0, 8), 16) % 100  // 0–99
const canAccess = bucket < server.rollout.percent
```

- `percent: 0` → nobody sees the server.
- `percent: 100` → everyone sees the server (default when field is omitted).
- `percent: 25` → deterministic 25% of users see the server (same users every time).

The hash is seeded with both `userId` and `server.id`, so the same user gets consistent 0/1 outcomes across restarts, and different servers produce different buckets for the same user.

---

## Rollout Percent Values

| Value | Meaning |
|-------|---------|
| `0` | Disabled / not visible |
| `1–99` | Gradual rollout (% of user base) |
| `100` | Full release (or omit the field entirely) |

---

## Distribution Versioning

The `distribution.json` includes a `version` and `timestamp` field:

```json
{
  "version": "1.2.3",
  "timestamp": "2024-06-01T12:00:00.000Z",
  ...
}
```

`timestamp` is used for:
1. **Anti-replay protection**: The launcher rejects remote distributions with an older timestamp than the cached local one. See [distro.md](./distro.md#anti-replay-protection).
2. **Cache invalidation**: If the remote timestamp is newer, the remote distribution replaces the local cache.

`version` is informational — it appears in logs and diagnostics but is not used for comparison logic.

---

## Rolling Back a Release

To roll back, publish a new distribution with:
- An **increased `timestamp`** (must be newer than the current live version).
- The affected server entry updated or reverted.
- A **new Ed25519 signature**.

You cannot "downgrade" to an older `distribution.json` because the anti-replay check will reject it.

---

## Testing Staged Rollouts Locally

Place a `distribution_dev.json` in the launcher data directory with `rollout.percent` set to any value. When the app is run from source (`npm start`, `!app.isPackaged`), it reads this file instead of the remote distribution. The rollout gating logic still runs against the local user's HWID.

To force a specific user into a rollout:
1. Set a fixed `clientToken` in `config.json`.
2. Pre-compute the bucket for that token + server ID.
3. Set `percent` above the bucket value.
