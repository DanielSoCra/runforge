# Rails Controller Patterns

Conventions for API controllers across all projects using this stack.

## Cursor-Based Pagination

Use `id` or `created_at` as cursor, not offset. Offset pagination degrades on large tables.

```ruby
def paginate(scope, cursor: params[:after], limit: [params.fetch(:limit, 25).to_i, 100].min)
  scope = scope.where("id > ?", cursor) if cursor.present?
  scope.order(:id).limit(limit + 1)
end
```

**Gotcha:** Fetch `limit + 1` to determine if there's a next page. Return only `limit` records.

## Two-Layer Deletion Guards

Check model-level `deletable?` before destroying. Database RESTRICT is the safety net.

```ruby
def destroy
  unless @record.deletable?
    return render json: { error: { code: "not_deletable", message: @record.deletion_blocked_reason } }, status: :unprocessable_entity
  end
  @record.destroy!
  head :no_content
end
```

## Internal API Auth

For service-to-service calls: `X-Internal-Key` header validated with timing-safe comparison.

```ruby
def authenticate_internal!
  key = request.headers["X-Internal-Key"]
  head :unauthorized unless ActiveSupport::SecurityUtils.secure_compare(key.to_s, ENV["INTERNAL_API_KEY"])
end
```

**Gotcha:** Always use `secure_compare` — string `==` is vulnerable to timing attacks.

## 202 Accepted for Async

When dispatching background work, return 202 with job metadata. Don't block the request.

```ruby
def create
  job = TaskExecutionJob.perform_later(task_id: @task.id)
  render json: { job_id: job.provider_job_id }, status: :accepted
end
```

## Error Serialization

Consistent error response shape across all endpoints.

```ruby
# All error responses follow this shape:
{ error: { code: "not_found", message: "Task not found", details: {} } }
```

**Gotcha:** Never leak internal error messages or stack traces. Map exceptions to user-facing messages.

## Scoped Queries

Always scope to authorized context. Never query unscoped.

```ruby
# Good
@tasks = current_project.tasks
# Bad
@tasks = Task.all
```
