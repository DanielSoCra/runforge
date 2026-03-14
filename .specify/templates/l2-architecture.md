---
id: ARCH-{DOMAIN-KEY}
type: architecture
domain: {domain}
status: draft
version: 1
layer: 2
references: FUNC-{PARENT-ID}
---

# ARCH-{DOMAIN-KEY} — {Title}

## Overview

<!-- How does the system achieve the behavior described in the referenced L1 spec? 2-3 sentences. -->

## Data Model

<!-- Entities, attributes, and relationships. Use plain language, not ORM syntax. -->
<!-- Example: "A Project has many Tasks. Each Task belongs to exactly one Project." -->

## API Contract

<!-- Endpoints, request/response shapes. Use system names (Backend, Agent Service), not framework names. -->
<!-- Include: method, path, request body, response body, status codes. -->

## System Boundaries

<!-- Which system owns this data? Where do reads/writes happen? -->
<!-- Example: "Backend owns Task records. Agent Service reads tasks via Internal API." -->

## Event Flows

<!-- What triggers what? Sequence of events across system boundaries. -->

## Error Handling

<!-- What can go wrong? How does each system respond? -->
