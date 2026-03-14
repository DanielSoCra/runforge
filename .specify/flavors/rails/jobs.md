# Rails Background Job Patterns

Conventions for Solid Queue jobs across all projects using this stack.

## Solid Queue as Default

No Redis dependency. Jobs stored in database. Sufficient for most workloads.

**Gotcha:** For high-throughput scenarios (>1000 jobs/minute sustained), consider Sidekiq. For everything else, Solid Queue is simpler.

## Rate Limiting via SQL Count

Check recent job count before enqueuing. Simple, no external rate limiter needed.

```ruby
def within_rate_limit?(type, max:, window: 1.hour)
  sent_count = where(email_type: type, created_at: window.ago..).count
  sent_count < max
end
```

**Gotcha:** This pattern is approximate under high concurrency. Acceptable for most use cases.

## Exponential Backoff Retries

Use Rails' built-in retry mechanism with polynomial backoff.

```ruby
retry_on StandardError, wait: :polynomially_longer, attempts: 5
discard_on ActiveRecord::RecordNotFound  # Non-retryable errors
```

**Gotcha:** Always specify `discard_on` for errors that won't resolve on retry (missing records, invalid input).

## Idempotency via Deduplication Key

Prevent double-processing by checking a deduplication key before executing.

```ruby
def perform(idempotency_key:, **args)
  return if already_processed?(idempotency_key)
  # ... do work ...
  mark_processed!(idempotency_key)
end
```

**Gotcha:** The check-and-mark must be atomic or wrapped in a transaction to avoid race conditions.

## Cancel Pending Pattern

Query and discard pending jobs matching criteria before enqueueing a replacement.

```ruby
def cancel_pending_follow_ups!(contact_id)
  SolidQueue::Job.where(class_name: "FollowUpJob")
    .where("arguments LIKE ?", "%contact_id: #{contact_id}%")
    .destroy_all
end
```

**Gotcha:** This pattern depends on job argument serialization format. Test with your actual serializer.
