# Research: Extended Capabilities for `@biguml` Chat Agent

**Ticket:** [#9 Research & Extended Capabilities](https://github.com/AdvancedModelEngineeringSS26/biguml-interview-agent/issues/9)
**Milestone:** Interim 2 (due 2026-05-22)
**Branch:** `feature/9_chat_references`

## Goal

Investigate and prototype advanced features that improve `@biguml` beyond basic diagram generation. Per the ticket's acceptance criteria, at least 2–3 extensions should be prototyped or clearly documented, with findings written up and a recommendation for the next iteration.

## Summary

Three extensions were prototyped end-to-end and committed to the branch:

1. **Chat references** (`#file:`, `#selection`) — the agent reads referenced files/selections and uses their content
2. **Auto-attach active `.uml` diagram** — implicit context awareness, no manual `#file:` needed
3. **Configurable model vendor/family** — users can switch the LLM backing the agent

Three further areas are scoped but not prototyped here, with reasons:

4. **Prompting strategy A/B** — partial; no formal evaluation yet
5. **Preview / confirmation UX** — blocked on [PR #14](https://github.com/AdvancedModelEngineeringSS26/biguml-interview-agent/pull/14)
6. **Inline chat integration** — deferred; deeper surface than fits this iteration

---

## 1. Chat references (`#file:`, `#selection`)

**Status:** Prototyped, working.
**Commits:** `5e44161`, `d311ba8`
**Code:** [interview-agent.participant.ts](client/packages/big-ai/src/env/vscode/interview-agent.participant.ts) — `buildReferenceMessages`, `resolveReferenceContent`, `describeReferences`.

### What was built

- `buildReferenceMessages(request)` iterates `request.references[]` and resolves each entry to a `LanguageModelChatMessage.User(...)` labeled `[Attached reference: <id>]`.
- `resolveReferenceContent(ref)` handles three concrete `value` shapes:
  - `vscode.Uri` → read via `vscode.workspace.fs.readFile`
  - `vscode.Location` → open document, slice to the range
  - `string` → use as-is (e.g. Copilot's auto-injected `vscode.customizations.index`)
- Each reference is capped at 30 000 characters with a truncation marker to avoid blowing the context window.
- The system prompt was updated with a "Reference Handling" section instructing the model to treat attached content as authoritative.

### What worked

- After attaching via the `#file:` autocomplete, the agent answers grounded in the actual file content (verified by quoting real class names like `NewClass1`, not hallucinating).
- Error path is non-fatal: a failed read produces `[Attached reference: X] (Failed to read content: …)` instead of crashing the turn.

### What did not / surprises

- **`ChatPromptReference` has no `name` field** — only `id`, `value`, `range`, and `modelDescription`. Several online examples use `ref.name`; that compiles only because `value` is typed `unknown`. We hit this as a TS error and fixed it (`d311ba8`).
- **Typing `#file:asd.uml` as plain text does nothing** — VS Code does not parse references back from raw text. The user must trigger the autocomplete (`#` → arrow keys → Enter) or use the attach button.
- **Copilot Chat auto-injects a `vscode.customizations.index` reference** (string type) containing its skills/customizations metadata. We treat it as a normal inline string; this also confirmed our handling is generic enough for future custom variables.

---

## 2. Auto-attach active `.uml` diagram

**Status:** Prototyped, working.
**Commit:** `51a8be4`
**Code:** [interview-agent.participant.ts](client/packages/big-ai/src/env/vscode/interview-agent.participant.ts) — `getActiveUmlUri`, `buildAutoAttachMessages`, `describeActiveDiagram`.

### What was built

- `getActiveUmlUri()` looks at `vscode.window.tabGroups.activeTabGroup?.activeTab.input`, supporting `TabInputText`, `TabInputCustom`, and `TabInputNotebook`. Returns the URI only if the path ends in `.uml`.
- `buildAutoAttachMessages(request)` reads the active diagram's content and appends a message labeled `[Auto-attached active UML diagram: <path>]`, unless the same URI was already explicitly referenced (deduped by comparing `Uri.toString()`).
- The system prompt now distinguishes auto-attached from explicit references and tells the model: use it when the question is about "this diagram" or "the current model"; ignore it for purely conceptual questions.

### Why this matters

This is the first feature where `@biguml` is materially more capable than plain Copilot. Copilot Chat can read `#file:`-attached files, but it cannot know which custom-editor tab is active — `.uml` files open in the GLSP-based custom editor, and `vscode.window.activeTextEditor` returns `undefined` for them. The agent reaching into `tabGroups` is what makes the implicit context possible.

### What worked

- Switching between `asd.uml` and `class_1768132987976.uml` immediately changes which diagram the agent describes (confirmed via control test).
- Conceptual questions like `/explain what is a class diagram` are not contaminated by the current-diagram content — the model honors the system prompt instruction.

### What did not

- No way today to disable auto-attach on a per-request basis other than asking a non-diagram question. A future setting (`bigUML.ai.autoAttachActiveDiagram`) would let users opt out.

---

## 3. Configurable model vendor/family

**Status:** Prototyped, working.
**Commit:** `7710690`
**Code:** [interview-agent.participant.ts](client/packages/big-ai/src/env/vscode/interview-agent.participant.ts) — `selectModel`; [package.json](client/application/vscode/package.json) — new settings under `bigUML.ai.*`.

### What was built

- Two settings:
  - `bigUML.ai.modelVendor` (default `copilot`)
  - `bigUML.ai.modelFamily` (default `gpt-4o`)
- `selectModel()` resolution chain: exact match → same vendor (any family) → any available model at all. Each fallback step is logged.
- Each response ends with a `_via <vendor>/<family>_` footer so the active model is visible without opening Settings.
- A hard failure (no models at all) produces a clear error pointing at the settings keys.

### What worked

- Switching the setting from `gpt-4o` to `gpt-4o-mini` is reflected in both the footer and the `big-ai` Output channel after a window reload.
- Fallback prevents silent breakage when a requested family isn't entitled by the user's Copilot tier.

### What did not / gotchas

- **Model availability depends on the Copilot subscription**: GPT-4o and GPT-4o-mini work on standard Copilot; Claude / Gemini families require enterprise entitlements that we could not test against.
- VS Code does not provide a UI listing of which models are entitled — users have to either guess and rely on the fallback, or call `vscode.lm.selectChatModels()` from a script to enumerate.
- Settings only re-read on the next request (no live reconfiguration mid-conversation), but this is acceptable given the per-turn footer.

### Suggested follow-up

- Replace the free-form `modelFamily` string with a `enumDescriptions` listing of common families to improve discoverability.
- Add a status-bar item showing the current model so users don't have to read each response footer.

---

## 4. Prompting strategies (partial)

**Status:** Not prototyped; existing prompt structure documented.

Current implementation: a single ~80-line system prompt in [ai.constants.ts](client/packages/big-ai/src/env/common/ai.constants.ts) plus per-mode addenda built in `buildSystemMessage`.

Open questions that a real A/B would answer:

- Does adding few-shot examples (input prompt → ideal `add-node` tool call) improve tool-call accuracy once PR #14 lands?
- Does a chain-of-thought prelude (`Think step by step: what UML elements does this user mention?`) improve interview-mode quality, or just add latency?
- Are the per-mode addenda actually distinguishable in output, or do they all collapse to the same response style under GPT-4o?

**Recommendation:** Run a fixed bench of 5–6 UML scenarios (e.g. "model a library system", "explain composition vs aggregation", "add a `Loan` class to the existing diagram") across three system-prompt variants. Score qualitatively on correctness, verbosity, and tool-use rate. Budget ~2 hours.

---

## 5. Preview / confirmation UX (blocked)

**Status:** Blocked by [PR #14](https://github.com/AdvancedModelEngineeringSS26/biguml-interview-agent/pull/14).

Reason: the VS Code `LanguageModelToolInvocationOptions.toolInvocationToken` mechanism only matters once tools that mutate the diagram exist. Today's only tool is `DummyTool` which logs and returns a string — there is nothing to confirm.

Once PR #14 (add-node / remove-node / add-relation / remove-relation / create-uml-file / read-uml-file) lands:

- In each mutating tool's `prepareInvocation()` method, return `LanguageModelToolConfirmationMessages` describing the planned change (e.g. *"Add class `Customer` with properties `name: String, email: String` to `asd.uml`?"*).
- VS Code surfaces a confirmation button; rejecting aborts the tool call.
- Default destructive tools (`remove-*`) to always-confirm; make additive tools opt-in via setting.

Estimated effort once unblocked: 1–2 hours.

---

## 6. Inline chat integration (deferred)

**Status:** Deferred to next iteration.

VS Code's inline chat is triggered via `vscode.commands.executeCommand('inlineChat.start', { initialChatText })`. The standard trigger only works in text editors; `.uml` files open in a custom editor where the inline-chat UI is not wired up by VS Code itself.

Two paths to evaluate:

- Register a custom command (e.g. `bigUML.askAgent`) bound to the diagram editor that opens the regular chat panel with the active element preloaded as context. Easier, but not "inline".
- Wait for / contribute to VS Code's inline-chat API for custom editors. Significantly deeper.

Recommendation: defer. This is a bigger UX swing than fits a 5-day Interim 2 budget.

---

## Recommendations for next iteration

Ordered by leverage:

1. **Wire preview/confirmation onto Ronja's tools** as soon as PR #14 merges. This is the highest UX swing and the one feature that visibly differentiates `@biguml` from plain Copilot for destructive changes.
2. **Run the prompt A/B test** described in §4 to back the system-prompt design with data instead of intuition.
3. **Register `#diagram` as a custom chat variable** that resolves to the active `.uml`. Same effect as today's auto-attach but discoverable in the chat dropdown — better UX.
4. **Token-budget management for large diagrams**: instead of dumping raw JSON when the file exceeds 30K chars, summarize structure (class names + relationships) and only include full bodies for the elements the user mentions.
5. **Add `bigUML.ai.autoAttachActiveDiagram` setting** so users can opt out of implicit context if they prefer explicit `#file:` references.
6. **Defer inline chat** until VS Code's custom-editor inline-chat story stabilizes.

---

## Open questions

- When both `#file:foo.uml` AND a *different* `.uml` is the active tab, both are attached. Does this confuse the model? Worth a manual test.
- Does Copilot prepend its own system prompt before our `LanguageModelChatMessage.User(systemPrompt)`? If so, our prompt has less leverage than it appears.
- Is the `vscode.customizations.index` reference Copilot injects something we should explicitly filter out, or does its skills metadata genuinely help the model? Not investigated.
- The model footer adds ~30 characters to every response. Worth making opt-out?

---

## Acceptance criteria

- [x] **At least 2–3 extensions are prototyped OR clearly documented** — 3 prototyped (§1, §2, §3), 3 documented (§4, §5, §6)
- [x] **Findings are documented** (this file)
- [x] **Clear recommendation for next iteration** (see above)

## Technical tasks (from the ticket)

- [x] Test chat references (`ChatRequest.references`) — §1
- [~] Implement diagram explanation — `/explain` works via auto-attach (§2). A dedicated mode that auto-resolves and structures the explanation could be a follow-up.
- [ ] Prototype preview/confirmation flow — blocked, see §5
- [~] Experiment with prompting strategies — structure documented (§4), formal A/B not run
- [x] Evaluate different models — §3

## Branch and commits

Branch: `feature/9_chat_references`

| SHA | Message |
|---|---|
| `5e44161` | feat: resolve #file and #selection chat references into LM context (#9) |
| `d311ba8` | fix: use ref.id instead of nonexistent ref.name on ChatPromptReference |
| `51a8be4` | feat: auto-attach active .uml editor as implicit context (#9) |
| `7710690` | feat: configurable model vendor/family with fallback (#9) |
