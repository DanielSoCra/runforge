export { PROTOCOL_VERSION } from "./protocol-version.js";

export {
  ITEM_STATUSES,
  type ItemStatus,
  TERMINAL_STATUSES,
  TRANSITION_EVENTS,
  type TransitionEvent,
  RISK_CLASSES,
  type RiskClass,
  RESUME_MODES,
  type ResumeMode,
  REVERSIBILITY,
  type Reversibility,
  EFFECT_KINDS,
  type EffectKind,
} from "./state-machine-types.js";

export {
  DecisionRequestSchema,
  OptionSchema,
  AnswerSchemaSchema,
  type AnswerSchema,
  type DecisionRequest,
  type DecisionOption,
} from "./decision-request.js";

export { DecisionResponseSchema, type DecisionResponse } from "./decision-response.js";

export { buildDecisionRequestJsonSchema } from "./json-schema.js";
