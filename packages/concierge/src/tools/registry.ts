export type JsonSchema = {
  type: string;
  additionalProperties?: boolean;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
};

export type BlastRadius = 'safe' | 'medium' | 'high';
export type AuditPolicy = 'always' | 'on_error_only';
export type ToolStatus = 'enabled' | 'disabled' | 'experimental';

export interface ToolHandlerContext {
  conversationId: string;
  toolCallId: string;
}

export interface ToolEntry {
  name: string;
  description: string;
  argsSchema: JsonSchema;
  handler: (args: unknown, context: ToolHandlerContext) => Promise<unknown>;
  blastRadius: BlastRadius;
  audit: AuditPolicy;
  cacheable: boolean;
  subsystem: string;
  governingSpecId: string | null;
  status: ToolStatus;
}

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

export interface ToolRegistry {
  get(name: string): ToolEntry | undefined;
  list(): ToolEntry[];
  toToolDefinitions(): ToolDefinition[];
}

const NAMESPACED_TOOL_NAME = /^[a-z][a-z0-9]*_[a-z0-9_]+$/;

export function createToolRegistry(entries: ToolEntry[]): ToolRegistry {
  const tools = new Map<string, ToolEntry>();

  for (const entry of entries) {
    validateEntry(entry);
    if (tools.has(entry.name)) {
      throw new Error(`duplicate tool name ${entry.name}`);
    }
    tools.set(entry.name, entry);
  }

  return {
    get(name: string): ToolEntry | undefined {
      return tools.get(name);
    },

    list(): ToolEntry[] {
      return [...tools.values()];
    },

    toToolDefinitions(): ToolDefinition[] {
      return [...tools.values()]
        .filter((entry) => entry.status !== 'disabled')
        .map((entry) => ({
          name: entry.name,
          description: entry.description,
          input_schema: entry.argsSchema,
        }));
    },
  };
}

function validateEntry(entry: ToolEntry): void {
  if (!NAMESPACED_TOOL_NAME.test(entry.name)) {
    throw new Error(`tool name ${entry.name} must be namespaced`);
  }
  if (entry.description.length > 200) {
    throw new Error(`tool description for ${entry.name} must be 200 chars or fewer`);
  }
  if (entry.argsSchema.type !== 'object') {
    throw new Error(`tool ${entry.name} argsSchema must be an object schema`);
  }
}
