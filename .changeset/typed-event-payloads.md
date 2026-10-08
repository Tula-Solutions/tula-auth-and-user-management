---
'@tula/contract': minor
---

Typed, versioned event payloads (ADR 0012): what a webhook will deliver is a contract from its
first delivery.

- `@tula/contract/event-types` (new entry point, no Zod): `ACTIVITY_TYPES` and `ActivityType`
  (moved here; still exported from the index), `EVENT_SCHEMA_VERSION` (1) and
  `EVENT_TARGET_TYPES` / `EventTargetType`, which says what each event's `target.id` is the id
  of.
- `EVENT_DATA_SCHEMAS`: the `data` of every event type. `EVENT_SCHEMAS`: the event itself,
  `{ id, type, schemaVersion, occurredAt, actor, target, data }`, with no IP address and no
  user agent. `TulaEventSchema` and the `TulaEvent` type are their union by `type` (not
  `Event`, which is the DOM's); `EventOf<T>` and
  `EventData<T>` name one type's. A payload is an allow-list: ids, values from closed sets,
  booleans; never an email address, a token or a secret.
- `EVENT_FIXTURES`: a valid example of every event type, as plain data.
- `MAX_CHANGED_SETTINGS` and `MAX_SETTING_NAME_LENGTH`: the bounds of the names an
  `environment.settings_updated` event lists in `changed`. The set of names is open.
- `openapi.json` gains the schemas as components (`TulaEvent`, `<Name>Event`, `<Name>EventData`,
  `EventActor`). No route changes.
