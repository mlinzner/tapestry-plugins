# Feedbin connector

This connector brings your feedbin.com RSS subscriptions into Tapestry. Requires Tapestry 2.0 or later.

## Read state

- **Mark as Read** and **Mark as Unread** update Feedbin, including its other clients. Simply viewing an article in Tapestry does not mark it as read in Feedbin.
- With **Fetch unread items only** enabled, the next successful refresh removes tracked items that are now read, whether marked here or in another Feedbin client. Tracking survives restarts and does not depend on the four-hour refresh window.
- With that setting disabled, read items remain in the timeline.

Removal tracking starts when this version loads an item in unread-only mode or you use its read/unread action in that mode. Older cached items outside the fetch window cannot be discovered retroactively; use their **Mark as Read** action to register them for removal.

Tapestry limits connector storage to 100,000 characters, shared with subscription details. If tracking fills that store, the connector reports an error rather than silently losing read-state changes.

## Development

Run the dependency-free tests from the repository root with Node.js 18 or later:

```sh
node --test
```

The tests mock the [Tapestry 2.0 API](https://github.com/TheIconfactory/Tapestry/blob/main/Documentation/API.md) and [Feedbin API](https://github.com/feedbin/feedbin-api). Before release, verify credentials, pagination, and read/unread actions in Tapestry; confirm that an unread-only refresh removes items marked as read both locally and in Feedbin, including after restarting Tapestry.
