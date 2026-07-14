# Execution Time Filters Design

## Goal

Allow agents to list or search workflow executions from a specific time window without scanning an arbitrary number of recent runs.

Examples:

```bash
n8n-helper executions <workflow> --from "2026-07-14 09:00" --to "2026-07-14 10:30"
n8n-helper executions <workflow> --since 2h
n8n-helper search "message text" <workflow> --since 30m
```

## Command Interface

Add the same time options to `executions` and workflow-targeted `search`:

- `--from <date-time>`: inclusive execution start lower bound.
- `--to <date-time>`: inclusive execution start upper bound.
- `--since <duration-or-date-time>`: lower bound relative to now or an explicit date-time. It cannot be combined with `--from`.

Supported relative durations are integer values followed by `m`, `h`, `d`, or `w`, such as `30m`, `2h`, `3d`, and `1w`. Explicit date-times use JavaScript date parsing. Inputs without a timezone use the machine's local timezone. When a lower bound is present and `--to` is omitted, the upper bound is the current time.

Invalid dates, invalid durations, `--since` combined with `--from`, or a lower bound after the upper bound return a `bad-arguments` error before any network request.

For an execution-targeted `search`, time filters are rejected because the execution is already selected.

## n8n API and Authentication

Time-filtered requests use n8n's authenticated internal endpoint:

```text
GET /rest/executions?filter=<json>&limit=<n>
```

The filter includes `workflowId`, optional status values, `startedAfter`, and `startedBefore`. Date values are normalized to ISO 8601 UTC timestamps.

The request sends both the saved `n8n-auth` cookie and the saved `browser-id`. The existing `SessionManager` supplies these values and refreshes an expired cookie once when saved email/password credentials are available.

The public `/api/v1/executions` endpoint is not used for time-filtered listing because it rejects `startedAfter` and `startedBefore`. There is no silent client-side pagination fallback.

## Missing Session Behavior

Existing execution listing without time filters continues to require only an API key.

When any time filter is supplied and no session cookie or saved email/password is available, return a structured `no-session` error. Its message and hint must explain that time filtering uses n8n's authenticated execution-list endpoint and provide the setup command:

```bash
n8n-helper login --url <instance-url> --email <email>
```

The login command prompts for the password and persists the session securely. The error must not imply that an API key alone can enable time filtering.

If session refresh fails, preserve the authentication failure and include the same setup guidance. Never print the cookie, browser ID, email, or password.

## Data Flow

`executions` parses and validates the time window, resolves the workflow and instance, then chooses the listing path:

- No time options: keep the existing public API pagination behavior.
- Any time option: list matching summaries through `/rest/executions`.

Workflow-targeted `search` uses the same listing abstraction to obtain candidate execution IDs, then fetches full execution data through the existing public API and applies the existing value-search logic. This keeps execution-data retrieval, caching, node filtering, and match formatting unchanged.

The internal endpoint's range pagination is followed until the requested result limit is reached or no matching executions remain. `--all` keeps its existing safety cap. Returned summaries are normalized to the existing execution output shape.

## Output

Existing execution and search output remains backward compatible. Time-filtered output additionally reports the normalized window:

```json
{
  "timeWindow": {
    "from": "2026-07-14T06:00:00.000Z",
    "to": "2026-07-14T07:30:00.000Z"
  }
}
```

This makes timezone interpretation auditable for agents.

## Testing

Tests cover:

- Parsing absolute local/UTC date-times and relative durations.
- Rejecting conflicting, invalid, and reversed bounds.
- Requiring a session only when time filters are used.
- Sending `filter`, cookie, and browser ID to `/rest/executions`.
- Refreshing once after a 401.
- Normalizing and paginating internal execution summaries.
- Applying the same candidate window to workflow-wide `search`.
- Rejecting time options for execution-targeted `search`.
- Preserving existing public API behavior when no time filter is supplied.
- Keeping secrets out of output and error messages.

No live executions are changed or retried by this feature.
