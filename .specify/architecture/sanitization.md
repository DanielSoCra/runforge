---
id: ARCH-AC-SANITIZATION
type: architecture
domain: auto-claude
status: draft
version: 1
layer: 2
references: FUNC-AC-DECISION-ESCALATION
---

# ARCH-AC-SANITIZATION — Input-Boundary Content Sanitization

## Overview

Inbound decision content passes through a single **Sanitization Pipeline** at the moment it enters the Decision Store, before any record is persisted or surfaced. The pipeline is a domain-blind, ordered chain of **Sanitizers**; with no Sanitizer configured it is the identity — content is stored exactly as provided. A deployment turns on confidentiality by configuring one or more Sanitizers in its **Deployment Profile**; a Sanitizer may transform inbound content (for example, recognize and withhold secret or personal content) and, when it withholds, hand the original to a separate **Redaction Store** for authorized reveal. Recognizing sensitive content is therefore a per-deployment capability composed at the boundary, not a rule baked into the decision protocol.

## Data Model

A **Sanitizer** is a named, ordered transformer with a description. It is defined in a **Sanitizer Catalog** owned by the Control Plane's code, not stored as data — analogous to the Plugin Registry. A Sanitizer takes inbound content and returns possibly-transformed content plus any withholding records; it carries no business meaning to the pipeline that runs it.

A **SanitizerBinding** is a per-deployment selection: it names a Sanitizer from the Catalog, an activation order, and optional settings. The ordered set of bindings for a deployment lives in that deployment's Profile (ARCH-AC-DEPLOYMENT-REGISTRY). An empty set — the default — means no sanitization.

A **SanitizationResult** is what the pipeline returns for one inbound request: the transformed content, and zero or more **Withholding** entries. A Withholding names the field that was withheld, a non-sensitive marker describing it, and a reference by which the authorized Operator may later reveal the original. With no Sanitizer configured there are no Withholding entries and the content is unchanged.

A **WithheldValue** is the original content a Sanitizer removed from inbound content. It lives in the Redaction Store, apart from the Decision Store's shared records, keyed by the reference recorded in its Withholding entry. It is produced only by a configured Sanitizer and revealed only to the authorized Operator.

## API Contract

- **run(content, deploymentRef)** — the Control Plane passes inbound decision content and the owning deployment to the pipeline. The pipeline resolves that deployment's ordered SanitizerBindings, applies each Sanitizer in order, and returns a SanitizationResult. With no bindings it returns the content unchanged and no Withholdings. Outcome: the SanitizationResult; or *failed* if a configured Sanitizer errors — on which the request is not persisted (see Error Handling).

- **reveal(withholdingRef, operator)** — returns the WithheldValue behind a Withholding reference. Outcome: the original content if the caller is the authorized Operator; *denied* otherwise; *not-found* if no such reference exists.

- **listCatalog()** — returns the available Sanitizers (identifier, description) so a Deployment Profile's bindings can be validated against real Sanitizer names. Outcome: the catalog entries.

## System Boundaries

The **Sanitization Pipeline** is owned by the Control Plane and invoked at the single decision-ingest seam, so every inbound request passes through it and the boundary cannot be bypassed. It holds no business rules of its own — it only resolves and runs the configured Sanitizers in order.

The **Sanitizer Catalog** owns Sanitizer definitions (code, not data). It is read when the pipeline is assembled and when a Profile is validated, and never written through the Profile.

The **Deployment Profile** (ARCH-AC-DEPLOYMENT-REGISTRY) owns the per-deployment SanitizerBindings — which Sanitizers run, in what order, with what settings. The default is none.

The **Redaction Store** owns WithheldValues, separate from the Decision Store. It is written only by a configured Sanitizer that withholds, and read only by an authorized reveal. The Decision Store, notifications, and run history hold only the pipeline's transformed (shared) content and never a WithheldValue.

The **Decision Store** (ARCH-AC-DECISION-ESCALATION) is content-agnostic: it persists exactly what the pipeline returns and makes no classification judgement of its own.

## Event Flows

1. A Worker raises a decision request; the Control Plane resolves the owning deployment and calls **run** with the inbound content before writing any record.
2. The pipeline reads the deployment's SanitizerBindings. With none configured it returns the content unchanged and no Withholdings, and the Control Plane persists the content as provided.
3. With one or more bindings, the pipeline applies each Sanitizer in activation order; a Sanitizer that withholds writes the original to the Redaction Store and returns a Withholding entry carrying a reveal reference in place of the value.
4. The Control Plane persists the transformed content to the Decision Store, with any Withholding entries recorded alongside the request; notifications and lists read only this shared content.
5. When the authorized Operator views a request carrying Withholdings, the Steering Surface calls **reveal** per reference to show the original; an unauthorized caller is denied.
6. When a deployment's Profile changes its SanitizerBindings, subsequent requests are sanitized under the new set; already-persisted requests are unaffected.

## Error Handling

- **No Sanitizer configured.** The pipeline is the identity; content is stored as provided. This is the default and is not an error.
- **A configured Sanitizer errors.** The pipeline reports *failed*; the Control Plane does not persist the request (failing closed rather than risk unsanitized content) and the owning run stays parked with the failure surfaced for retry, so the decision pause is never silently lost. This mirrors the decision-escalation rule that an unseparable sensitive request is never published while its run remains parked.
- **Unknown Sanitizer named in a Profile.** The binding is rejected when the Profile is validated against the Catalog; an unknown Sanitizer never silently becomes a no-op that lets content through unsanitized.
- **Reveal of an unknown or already-removed reference.** Returns *not-found*; the Operator is told rather than shown stale or empty content.
- **Unauthorized reveal.** Returns *denied*; a WithheldValue is exposed only to the authorized Operator.
- **Redaction Store unavailable when a Sanitizer must withhold.** The Sanitizer fails, which fails the pipeline closed as above — content is never persisted in the clear because its secure store was unreachable.
