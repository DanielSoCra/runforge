# @runforge/concierge

Spec-governed concierge core package.

Implemented surfaces:

- conversation lifecycle store
- cache-stable prompt block assembly
- auditable tool registry and router
- high-blast-radius confirmation lifecycle
- default toolbox manifest from `ARCH-TOOL-REGISTRY`
- Slack request signature verification and confirmation action parsing
- vault access policy boundaries
- forward-only migration runner boundary
- observer secret-path filtering

External clients are intentionally injected or left as explicit not-configured
handlers. The package does not silently pretend Slack, mail, vault, GitHub, or
runforge clients exist before they are wired.
