# FastAPI Endpoint Patterns

## Router-Per-Domain
One `APIRouter` per domain concern. Mount on main app with prefix. Keep route handlers thin.

```python
router = APIRouter(prefix="/tasks", tags=["tasks"])

@router.post("/", status_code=201)
async def create_task(body: CreateTaskRequest, service: TaskService = Depends(get_task_service)):
    return await service.create(body)
```

## Pydantic Models
Separate request and response models. Use `model_validator` for cross-field validation.

```python
class CreateTaskRequest(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    project_id: UUID

class TaskResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: UUID
    title: str
    status: str
```

**Gotcha:** Never reuse the same model for input and output — they have different field requirements.

## Dependency Injection
Use FastAPI's `Depends()` for service instantiation.

```python
async def get_task_service(db: AsyncSession = Depends(get_db)) -> TaskService:
    return TaskService(db)
```

## Error Handling
Raise `HTTPException` with structured detail. Register custom exception handlers for domain exceptions.

```python
raise HTTPException(status_code=404, detail={"code": "task_not_found", "message": f"Task {id} not found"})
```

**Gotcha:** Register a global exception handler that catches domain exceptions and maps them to HTTPException.
