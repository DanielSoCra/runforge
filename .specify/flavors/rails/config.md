# Rails Configuration Patterns

Conventions for authentication, storage, WebSocket, and infrastructure configuration.

## Authentication

Use `has_secure_password` for user passwords (BCrypt). API keys as a separate model.

```ruby
# User: simple BCrypt password
has_secure_password

# ApiKey: prefix lookup + BCrypt comparison
key, raw = ApiKey.generate!(scopes: ["tasks:read", "tasks:write"])
# raw returned once, stored as BCrypt digest
```

**Gotcha:** `ApiKey.generate!` returns `[record, raw_key]` tuple. The raw key is shown once and never stored.

## File Storage

Active Storage with S3-compatible backend. Direct upload via presigned URLs.

```ruby
# config/storage.yml
production:
  service: S3
  endpoint: https://fsn1.your-objectstorage.com
  bucket: project-assets
```

**Gotcha:** Set appropriate CORS headers for direct uploads from the browser.

## WebSocket

Action Cable with Solid Cable adapter (database-backed, no Redis).

Channel naming convention: `{model}:{id}` (e.g., `project:abc-123`).

```ruby
# Channel subscription
stream_for project
# Broadcasting
ProjectChannel.broadcast_to(project, { event: "task.updated", data: serialized })
```

## Background Jobs

Solid Queue configuration. Queue priority levels: default, high, low.

```yaml
# config/solid_queue.yml
dispatchers:
  - polling_interval: 1
    batch_size: 500
workers:
  - queues: [high, default, low]
    threads: 5
```

## i18n

English for admin/internal, localized for client-facing portals.

```ruby
I18n.with_locale(contact.locale) do
  # All strings in this block resolve to contact's language
end
```

**Gotcha:** Store translations in `config/locales/`. Never hardcode user-facing strings.

## Research Before Implementation

Before writing any Rails code, verify current best practices. Training data goes stale — Rails conventions evolve across versions.

1. **Check context7 docs** — query `/rails/rails` or `/websites/guides_rubyonrails` for the specific API, generator, or feature you're about to use
2. **Web search** — search for current best practices, version-specific changes, and community conventions (e.g., "Rails 8 authentication best practices")
3. **Verify project Rails version** — run `bin/rails --version` and ensure patterns match the project's actual version, not the latest release

```bash
# Always check the project's Rails version first
bin/rails --version

# Then verify conventions match via context7 and web search
```

**Gotcha:** This applies to ALL Rails work, not just unfamiliar APIs. Even well-known patterns (routing, associations, testing) change across major versions. Never assume — verify.

## Prefer Rails CLI Generators

Always use `bin/rails generate` over hand-writing boilerplate. Generators produce files that follow Rails conventions, include test stubs, and stay consistent with the project's configuration.

```bash
# Always prefer generators over hand-writing files
bin/rails generate model Product name:string price_cents:integer
bin/rails generate controller Products index show
bin/rails generate scaffold Order status:string total_cents:integer
bin/rails generate migration AddInventoryCountToProducts inventory_count:integer
bin/rails generate job ProcessOrder
bin/rails generate mailer OrderConfirmation
bin/rails generate channel Notifications
bin/rails generate authentication
```

Key generators:

| Task | Command | Notes |
|------|---------|-------|
| New model | `bin/rails generate model` | Generates model, migration, and test |
| New controller | `bin/rails generate controller` | Generates controller, views, routes, and test |
| Full CRUD | `bin/rails generate scaffold` | Generates model, migration, controller, views, routes, and tests |
| Migration | `bin/rails generate migration` | Use naming conventions (e.g., `AddXToY`) for auto-populated columns |
| Background job | `bin/rails generate job` | Generates job class and test |
| Mailer | `bin/rails generate mailer` | Generates mailer, views, and test |
| WebSocket channel | `bin/rails generate channel` | Generates channel and JavaScript |
| Authentication | `bin/rails generate authentication` | Rails 8+ built-in auth scaffolding |

After generation, adjust for project conventions:
- Change `id: :bigint` to `id: :uuid` in migrations (see models.md UUID pattern)
- Convert integer enums to string-backed enums (see models.md String-Backed Enums)
- Remove generated files you don't need (e.g., `--skip-jbuilder`, `--skip-routes` flags)

**Gotcha:** Run `bin/rails generate <generator> --help` to see all available options before generating. Use `bin/rails destroy <generator>` to cleanly undo a generation if needed.
