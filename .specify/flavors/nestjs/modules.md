# NestJS Module Patterns

## Module-Per-Domain
One NestJS module per business domain. Module encapsulates controller, service, and repository.

```typescript
@Module({
  controllers: [TaskController],
  providers: [TaskService, TaskRepository],
  exports: [TaskService],
})
export class TaskModule {}
```

**Gotcha:** Only export services that other modules need. Keep repositories private to their module.

## Guard/Interceptor/Pipe Separation
Guards for auth/authz, Interceptors for logging/transformation, Pipes for validation. Never mix concerns.

```typescript
@UseGuards(AuthGuard)           // WHO can access
@UseInterceptors(LoggingInterceptor)  // WHAT gets logged
@UsePipes(ValidationPipe)       // WHAT shape is valid
```

## Global vs Module-Scoped
Auth guard, validation pipe, and logging interceptor are global. Domain-specific interceptors are module-scoped.

**Gotcha:** Register global providers in AppModule with `APP_GUARD`/`APP_PIPE`/`APP_INTERCEPTOR` tokens.

## Dynamic Modules for Config
Use `ConfigModule.forRoot()` for environment-specific configuration. Validate env vars at startup.

```typescript
ConfigModule.forRoot({
  validationSchema: Joi.object({ DATABASE_URL: Joi.string().required() }),
  validationOptions: { abortEarly: false },
})
```

**Gotcha:** Use `abortEarly: false` to see ALL missing vars at once, not just the first. Fail fast on startup, but report everything.
