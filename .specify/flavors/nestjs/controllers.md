# NestJS Controller Patterns

## DTO Validation
Use `class-validator` decorators on request DTOs. `ValidationPipe` with `whitelist: true` strips unknown properties.

```typescript
@Post()
create(@Body() dto: CreateTaskDto) {
  return this.taskService.create(dto);
}
// ValidationPipe auto-validates and strips unknown fields
```

**Gotcha:** Always set `whitelist: true` and `forbidNonWhitelisted: true` to prevent mass assignment.

## Response Serialization
Use `class-transformer` with `@Exclude()` on sensitive fields.

```typescript
@Exclude()
passwordHash: string;

@Expose()
get displayName(): string { return `${this.firstName} ${this.lastName}`; }
```

## Error Responses
Consistent error shape via custom exception filter.

```typescript
// All errors follow: { error: { code: string, message: string, details?: object } }
throw new NotFoundException({ code: "task_not_found", message: "Task does not exist" });
```

**Gotcha:** Register a global `HttpExceptionFilter` to normalize all error responses to the standard shape.

## Swagger/OpenAPI
Decorate every endpoint with `@ApiOperation` and `@ApiResponse`. Generate spec at build time.

```typescript
@ApiOperation({ summary: "Create a task" })
@ApiResponse({ status: 201, type: TaskResponseDto })
```

**Gotcha:** Keep response DTOs separate from entity classes — never expose your database schema in the API spec.
