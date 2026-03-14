# LangGraph Agent Patterns

## StateGraph Orchestration
Define agent workflow as a `StateGraph`. Each node is a function that reads/writes state.

```python
graph = StateGraph(AgentState)
graph.add_node("plan", plan_node)
graph.add_node("execute", execute_node)
graph.add_edge("plan", "execute")
```

**Gotcha:** Keep nodes focused — one responsibility per node. Complex logic should be in service functions, not inline in nodes.

## Checkpointing
Use LangGraph's built-in checkpointing with PostgreSQL backend for crash recovery.

```python
checkpointer = AsyncPostgresSaver.from_conn_string(DATABASE_URL)
app = graph.compile(checkpointer=checkpointer)
```

**Gotcha:** Checkpoint after each node, not just at the end. This enables resuming from the last successful step.

## Tool Registration
Tools as decorated functions with Pydantic input schemas. Register on agent construction.

```python
@tool
def create_artifact(title: str, content: str, project_id: str) -> dict:
    """Create a new artifact in the project."""
    return artifact_client.create(title=title, content=content, project_id=project_id)
```

**Gotcha:** Tool descriptions are part of the prompt — write them clearly. The LLM reads them to decide which tool to use.

## Structured Output
Use LLM's structured output mode for reliable parsing. Define output schema as Pydantic model.

```python
class PlanOutput(BaseModel):
    steps: list[str]
    estimated_duration: int

response = llm.with_structured_output(PlanOutput).invoke(messages)
```

## Cost Tracking
Wrap LLM calls to capture token usage. Report costs via internal API after each agent step.

```python
result = await llm.ainvoke(messages)
cost_client.log(
    tokens_in=result.usage.input_tokens,
    tokens_out=result.usage.output_tokens,
    model=result.model,
)
```

**Gotcha:** Track costs per task, not per agent invocation — a single task may require multiple LLM calls.
