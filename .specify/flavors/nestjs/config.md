# NestJS Configuration Patterns

## Environment Config
`@nestjs/config` with Joi validation. Fail fast on missing/invalid env vars at startup.

```typescript
ConfigModule.forRoot({
  validationSchema: Joi.object({
    DATABASE_URL: Joi.string().required(),
    PORT: Joi.number().default(3000),
  }),
})
```

## TypeORM Setup
Entities auto-loaded. Migrations in `src/migrations/`. Never `synchronize: true` in production.

```typescript
TypeOrmModule.forRoot({
  autoLoadEntities: true,
  synchronize: false,  // ALWAYS false in production
  migrationsRun: true,
})
```

**Gotcha:** `synchronize: true` drops and recreates tables. Use it only in local development with disposable data.

## BullMQ Jobs
One queue per domain concern. Processor in dedicated service.

```typescript
@Processor("tasks")
export class TaskProcessor {
  @Process("execute")
  async handle(job: Job<TaskPayload>) { /* ... */ }

  @OnQueueFailed()
  async onFailed(job: Job, error: Error) { /* log and alert */ }
}
```

**Gotcha:** Set `backoff: { type: 'exponential', delay: 1000 }` on job options for retry.

## Health Checks
`@nestjs/terminus` with database, memory, and queue health indicators.

```typescript
@Get("health")
@HealthCheck()
check() {
  return this.health.check([
    () => this.db.pingCheck("database"),
    () => this.memory.checkHeap("memory", 200 * 1024 * 1024),
  ]);
}
```
