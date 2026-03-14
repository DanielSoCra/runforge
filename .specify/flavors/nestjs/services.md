# NestJS Service Patterns

## Repository Pattern
Inject repository, not raw database client. Service contains business logic only.

```typescript
@Injectable()
export class TaskService {
  constructor(private readonly taskRepo: TaskRepository) {}

  async findOrFail(id: string): Promise<Task> {
    return this.taskRepo.findOneOrFail({ where: { id } });
  }
}
```

## Transaction Handling
Use `DataSource.transaction()` for multi-table operations. Pass manager to repository methods.

```typescript
await this.dataSource.transaction(async (manager) => {
  await manager.save(Task, task);
  await manager.save(AuditLog, log);
});
```

**Gotcha:** Never nest transactions. If a service method might be called inside a transaction, accept an optional `EntityManager` parameter.

## Service-to-Service Communication
Inject service directly via constructor. Avoid circular dependencies.

```typescript
constructor(
  private readonly taskService: TaskService,
  private readonly notificationService: NotificationService,
) {}
```

**Gotcha:** If circular dependency is unavoidable, use `forwardRef(() => ServiceClass)`. But first consider extracting a shared service.

## Domain Exceptions
Throw domain-specific exceptions. Let exception filters translate to HTTP status codes.

```typescript
export class TaskNotFoundException extends NotFoundException {
  constructor(id: string) {
    super({ code: "task_not_found", message: `Task ${id} not found` });
  }
}
```
