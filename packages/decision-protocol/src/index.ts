export { PROTOCOL_VERSION } from "./protocol-version.js";

export {
  SENSITIVITY_CLASSES,
  type SensitivityClass,
  sensitivityRank,
  type Sink,
  allowedSinks,
  isProtected,
  IncompleteClassificationError,
  assertFullyClassified,
} from "./sensitivity.js";

export {
  SENSITIVITY_FIELD_PATHS,
  OPERATIONAL_FIELD_PATHS,
  REDACTABLE_FIELD_PATHS,
} from "./field-paths.js";

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
  FieldSensitivitySchema,
  SensitivityClassSchema,
  type DecisionRequest,
  type DecisionOption,
} from "./decision-request.js";

export { DecisionResponseSchema, type DecisionResponse } from "./decision-response.js";

export { buildDecisionRequestJsonSchema } from "./json-schema.js";
