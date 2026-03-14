# FastAPI Service Patterns

## Async HTTP Client
Use `httpx.AsyncClient` with connection pooling. Shared client instance via dependency injection.

```python
async def get_http_client() -> AsyncGenerator[httpx.AsyncClient, None]:
    async with httpx.AsyncClient(base_url=settings.backend_url, timeout=30) as client:
        yield client
```

**Gotcha:** Never create a new client per request — use connection pooling via `Depends()`.

## Retry with Backoff
Hand-rolled async retry with exponential delays. Wrap external API calls only.

```python
async def retry_with_backoff(fn, max_attempts=3, base_delay=1.0):
    for attempt in range(max_attempts):
        try:
            return await fn()
        except httpx.HTTPStatusError:
            if attempt == max_attempts - 1:
                raise
            await asyncio.sleep(base_delay * (2 ** attempt))
```

Alternatively, use `tenacity` if the project prefers a library — both approaches are valid.

## Circuit Breaker (Optional)

For external service calls that may be down. Manual state tracking or `circuitbreaker` library. Not always needed — use when a downstream service has known reliability issues.

**Gotcha:** Circuit breakers add complexity. Only introduce them when you have evidence of downstream instability.

## Internal API Client Base
Shared base class for all Backend API clients. Handles auth, error parsing, retry.

```python
class BaseInternalClient:
    def __init__(self, client: httpx.AsyncClient, api_key: str):
        self.client = client
        self.headers = {"X-Internal-Key": api_key}
```

Each domain client extends with specific methods (e.g., `ArtifactClient`, `TaskClient`).

## Frozen Pydantic Models
Use `frozen=True` for response models to prevent accidental mutation.

```python
class TaskResponse(BaseModel):
    model_config = ConfigDict(frozen=True)
    id: UUID
    title: str
```
