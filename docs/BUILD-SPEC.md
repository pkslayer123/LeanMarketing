# Lean Startup AI-Assisted Marketing Governance Document

This document defines the governing rules for building and operating an AI-assisted marketing system for startup ideas.

This system is grounded in Lean Startup thinking. Every decision must prioritize validated learning over activity. The purpose of this system is to test assumptions quickly, cheaply, and with real-world evidence before scaling.

If a decision increases complexity without increasing learning speed or evidence quality, it violates this document.

This document is written for a founder with no formal marketing background. It defines how decisions are made. It defines what must be true before scaling. It defines how software agents must behave when building or running the system.

This document must guide all prompts to coding agents. Coding agents must follow this structure and must not invent new layers or workflows.

This system is intended to recognize existing and new projects in the persona daemon network (excluding itself) and act as a single location to manage autonomous marketing assistance. You will use existing project documents from the repo to perform layer 1. Each project marketed should have its own tab/dashboard. We must never allow data/communication regarding separate projects to intermingle. The app needs accounts/authentication to support access for multiple employees, but we don’t need special role definition as this product is internal. New projects created via persona engine must be detected by this project daemon and added to scope of this build.

# Core Principles

1. Start with the smallest test that can produce real evidence.
2. Do not scale volume until there is signal.
3. Change one major variable at a time.
4. Automate delivery, not thinking.
5. Every campaign must have a clear next step that moves toward payment.

# System Layers (Must Remain Consistent)

Layer 1: Idea Definition and Assumption Clarity Layer 2: Audience Identification and Outreach Layer 3: Conversation and Qualification Layer 4: Proof and Demonstration Layer 5: Paid Conversion Layer 6: Review and Adjustment

All modules and coding prompts must align to these six layers.

# Layer 1 — Idea Definition and Assumption Clarity

Before outreach begins, the system must store:

- A one-sentence description of the idea.
- A one-sentence description of who it helps.
- A one-sentence description of the problem.
- A clear statement of what must be true for someone to pay.
- A definition of the smallest believable next step after someone replies.

No campaign may launch without these fields completed.

Quality Gate 1 (Pass/Fail):

The campaign may not launch unless all statements below are true:

1. A non-technical reader can explain the idea in one sentence after reading it once.
2. The problem statement describes a specific situation, not a general frustration.
3. The person who experiences the problem is clearly identified.
4. The next step after reply is defined in one sentence.

If any statement is false, the idea is not ready for outreach.

# Layer 2 — Audience Identification and Outreach

The system must:

1. Define a clear type of person and company.
2. Record inclusion and exclusion rules in full sentences.
3. Source leads from allowed and traceable sources.
4. Record why each lead fits.
5. Enroll leads into an approved sending engine.
6. Run two message versions in parallel.
7. Stop sending automatically when a reply occurs.

Quality Gate 2 (Pass/Fail):

Outreach may not begin unless all statements below are true:

1. The audience definition includes a job role and a company type.
2. Each lead has a written reason for why they fit.
3. The message does not promise results that cannot be proven.
4. The message asks for only one clear action.
5. Opt-out handling is enabled and tested.

If any statement is false, outreach must not start.

# Layer 3 — Conversation and Qualification

When replies arrive, the system must:

1. Classify replies into clear categories:
	- Not relevant
	- Curious
	- Interested
	- Ready to evaluate
2. Suggest the smallest next action.
3. Record all exchanges.
4. Move leads through visible stages.

Qualification must be short and written whenever possible. Calls are used only when necessary.

Quality Gate 3 (Pass/Fail):

A lead may not advance stages unless all statements below are true:

1. The reply classification matches the actual text of the reply.
2. The proposed next action requires less than ten minutes of effort from the recipient.
3. The next action matches the level of interest shown.
4. The exchange is logged completely in the system.

If any statement is false, the lead remains in the current stage.

# Layer 4 — Proof and Demonstration

Once interest is confirmed, the system must provide proof. Proof may take one of three forms:

1. A short written summary.
2. A short walkthrough demonstration.
3. A small real-use trial.

If the product is already built, the system may direct the user to a landing page or controlled demo.

Landing Page Rules: - The landing page must describe the problem clearly. - It must explain the outcome, not technical features. - It must include one clear call to action. - It must not overwhelm with multiple paths.

Demo Rules: - The demo must be under ten minutes to consume. - It must show outcome before features. - It must end with a clear decision request.

Quality Gate 4 (Pass/Fail):

Proof may not be considered valid unless all statements below are true:

1. The proof clearly shows the outcome, not only features.
2. The proof can be consumed in under ten minutes.
3. The proof ends with one clear decision request.
4. The proof does not introduce new complexity that was not mentioned earlier.

If any statement is false, the proof must be revised.

# Layer 5 — Paid Conversion

If proof is accepted, the system must propose a paid step.

The paid step must include: - Scope. - Time period. - Price. - Clear definition of success.

If the idea is already a working application, the paid step may be: - A limited free trial with upgrade path. - A discounted early access plan. - A pilot agreement with fixed duration.

Quality Gate 5 (Pass/Fail):

A paid offer may not be sent unless all statements below are true:

1. Scope is described in concrete terms.
2. Duration is defined with a start and end.
3. Price is stated clearly.
4. Success is defined in measurable terms.

If any statement is false, the offer is not ready.

# Layer 6 — Review and Adjustment

The system must review performance weekly.

The review must answer: 1. How many messages were sent? 2. How many replied? 3. How many advanced stages? 4. Where is the biggest drop-off? 5. What single variable will change next?

Only one major change may occur per cycle.

Quality Gate 6 (Pass/Fail):

A weekly change may not occur unless all statements below are true:

1. At least 30 outreach attempts were completed in the current cycle, or a clear reason is documented for lower volume.
2. The bottleneck is identified using actual stage counts.
3. Only one major variable is selected for change.
4. The hypothesis for the next cycle is written in one sentence.

If any statement is false, no strategic change is made.

# Application Architecture Rules

The application is the decision engine. The outreach provider is only a delivery engine.

The application must: - Store ideas. - Store segments. - Store leads. - Store message templates. - Store event logs. - Store reply classifications. - Store stage transitions.

The provider adapter must: - Send messages. - Stop on reply. - Report events back via webhook.

The core business logic must not depend on a specific provider.

# Approval Modes

Strict Mode: - All classifications require approval. - All next actions require approval.

Relaxed Mode: - Low-risk replies may advance automatically. - High-risk transitions require approval.

The founder may change mode at any time.

# What This System Is Not

It is not a content generator. It is not a social media posting engine. It is not a vanity metric tracker.

It is a structured system to move from idea to paid customer using controlled experiments and automation.

# Governance Requirement

Any coding prompt must reference this document. If a coding prompt conflicts with these layers or quality gates, this document overrides it.

No new workflow layers may be introduced without updating this document first.

# Master Build Prompt for Coding Agents

This section is a reusable, copy-paste prompt for AI coding tools. It tells the tool how to interpret this governance document and how to produce work that is safe, consistent, and testable.

Copy and paste the full prompt below into your coding tool at the start of any build task.

## Master Build Prompt (copy/paste)

You are an expert software engineer building an AI-assisted marketing operations application.

You must treat the attached governance document as the source of truth. If the task request conflicts with the governance document, the governance document wins.

Your job is to implement only the requested scope. You must not invent features that are not requested.

You must write clear, complete sentences. You must avoid marketing jargon.

### Lean default interpretation rules (use these when anything is unclear)

1. Prefer the smallest change that produces usable evidence.
2. Prefer simple, testable solutions over flexible architectures.
3. Prefer provider-neutral core logic, with one adapter implemented at a time.
4. Prefer automation that is safe and measurable over manual busywork.

### How to interpret the governance document

1. You must preserve the six layers as the organizing structure of the application.
2. You must implement the Quality Gates as real pass/fail checks in the product whenever possible.
3. You must keep the application provider-neutral. Do not hard-code any single outreach provider.
4. The outreach provider is a delivery engine only. The application is the decision engine.
5. The system must support automation of delivery, but it must not scale volume until there is evidence.
6. The system must change only one major variable per experiment cycle.

### Questions and assumptions policy (Lean default)

- Do not ask questions unless missing information blocks implementation.
- If something is unclear but not blocking, make the best conservative assumption and document it.

### Build discipline

1. If working in an existing repository, inspect the current code and database schema first.
2. Add only what is necessary for the requested feature.
3. Use safe defaults and do not remove existing behavior unless the request explicitly says to.
4. Prefer small, incremental changes that can be reviewed quickly.

### Required “done” standard (Lean default)

Every task must include: - A verification checklist. - At least one automated test when it is reasonable to do so. If a test is not reasonable, you must explain why and provide an alternative verification method.

### Approval mode default

The product must support a Strict mode and a Relaxed mode. The default must be Strict mode. A visible toggle must exist so the founder can change mode later.

### Technology assumption for a new repository

Unless told otherwise, assume: - Next.js - TypeScript - Supabase (Postgres)

If the request specifies a different stack, follow the request unless it violates safety rules.

### What you must produce in every response

For every task, output the following sections in this exact order:

1. What you understood. State the exact scope you will implement in one paragraph.
2. Assumptions. List any assumptions you are making. If something is unknown, say so.
3. Files you will change. List the files or folders you plan to create or modify.
4. Step-by-step plan. Explain the steps you will take.
5. Implementation. Provide the code changes.
6. Verification. Provide a short checklist to confirm the feature works.
7. Risks. List any risks, especially around sending automation, opt-out handling, and data logging.

### Safety rules for automated outreach (mandatory)

1. You must include opt-out handling.
2. You must include rate limits and sending caps.
3. You must stop on reply.
4. You must log every send and every reply.
5. If these cannot be implemented in the current scope, you must explicitly call that out and propose the smallest safe alternative.

### Milestones

The current Lean default build plan is:

- Milestone 1: Build the full workflow with a Mock Sender so the app can be tested end-to-end without any external provider.
- Milestone 2: Add exactly one real outreach provider adapter and webhook ingestion.

Do not implement Milestone 2 unless the task explicitly requests it.

## End of Master Build Prompt
