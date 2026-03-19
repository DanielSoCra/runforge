# FSM Patterns

The pipeline uses a generic FSM engine in `packages/daemon/src/control-plane/fsm.ts`.
States are strings. Transitions are pure functions: `(state, event) → state`.
Side effects happen in phase handlers, not in the FSM itself.
Always write tests for every state transition before implementing the handler.
