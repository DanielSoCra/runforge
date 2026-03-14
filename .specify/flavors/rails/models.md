# Rails Model Patterns

Conventions for ActiveRecord models across all projects using this stack.

## UUID Primary Keys

All tables use UUID primary keys with database-generated defaults.

```ruby
create_table :tasks, id: :uuid do |t|
  t.references :project, type: :uuid, foreign_key: true, null: false
end
```

**Gotcha:** Always specify `type: :uuid` on foreign key columns — Rails defaults to integer.

## String-Backed Enums

Use string-backed enums, never integers. Strings are self-documenting in the database and survive reordering.

```ruby
enum :status, { draft: "draft", active: "active", archived: "archived" }, default: :draft
```

**Gotcha:** Rails 7+ hash syntax required. The older array syntax creates integer-backed enums.

## Money as Integer Cents

Store monetary values as integer cents. No floats for financial data.

```ruby
# Store: 1999 (cents)  Display: $19.99
def display_price
  price_cents / 100.0
end
```

**Gotcha:** Use `decimal(8,1)` for credits that need fractional precision.

## Immutable Fields

Use `attr_readonly` for fields that must not change after creation.

```ruby
attr_readonly :key, :project_id
```

**Gotcha:** `attr_readonly` silently ignores updates — it does not raise. Add a custom validation if you need an error message.

## Deletion Guards

Two-layer protection: model-level `deletable?` check + database-level RESTRICT foreign keys.

```ruby
def deletable?
  tasks.none? && contracts.none?
end

# Migration: foreign_key: { on_delete: :restrict }
```

**Gotcha:** Always check `deletable?` in the controller before calling `destroy`. The database RESTRICT is a safety net, not the primary guard.

## Timestamps in UTC

All `created_at`/`updated_at` in UTC. Application handles timezone display.

**Gotcha:** Never store user-local times. Convert at the view/API layer.

## State Machines

Use enum + transition validation methods rather than a state machine gem. Keep it simple.

```ruby
def can_transition_to?(new_status)
  ALLOWED_TRANSITIONS[status.to_sym]&.include?(new_status.to_sym)
end
```

**Gotcha:** Always validate transitions before updating. Never allow arbitrary status changes.

## Scoped Uniqueness

Use scoped uniqueness for composite unique constraints.

```ruby
validates :key, uniqueness: { scope: :project_id }
```

**Gotcha:** Always add a matching database unique index — model validation alone has race conditions.

## Event Emission

Use after-commit callbacks to broadcast domain events for cross-system sync.

```ruby
after_commit :emit_created_event, on: :create

private
def emit_created_event
  EventBus.publish("task.created", { id: id, project_id: project_id })
end
```

**Gotcha:** Use `after_commit`, not `after_create` — the record must be persisted and visible to other transactions.
