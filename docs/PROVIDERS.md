# Provider adapters

The canonical protocol is a semantic intermediate representation. It does not
pretend OpenAI and Anthropic have the same native grammar.

## Normalization

The built-in pure adapters accept a durable JSON response object, so they do
not require vendor SDKs:

- `fromOpenAIResponse()`
- `fromOpenAIChatCompletion()`
- `fromAnthropicMessage()`

They normalize shared semantics—text, client tool calls, reasoning, stop
reason, requested/served model, token usage, caching, request identity, and
latency—while retaining:

- provider metadata on recognized blocks;
- unknown content as `provider` blocks;
- an exact response snapshot, inline by default or as `rawArtifact`.

Inputs that cannot round-trip through JSON are rejected at the adapter
boundary. Convert SDK class instances to their JSON response shape before
normalizing them.

Set `preserveRawResponse: false` only when another layer already stores the
exact provider response.

## Encoding

`toOpenAIInput()` emits Responses API input Items. Assistant output messages,
function calls, reasoning items, and function-call outputs remain distinct
items. This follows OpenAI’s documented mapping:

- [Responses migration: map messages to Items](https://developers.openai.com/api/docs/guides/migrate-to-responses#2-map-messages-to-items)
- [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

`toAnthropicInput()` emits a top-level `system` string and alternating
user/assistant messages. Canonical tool-role messages become Anthropic user
messages containing `tool_result` blocks:

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

## Fail-loud boundary

Artifacts contain bytes, while provider image/file inputs require a URL,
provider file ID, or base64 payload. The kernel cannot invent that mapping.
Therefore the built-in encoders throw `ProviderEncodingError` for image/file
blocks. Applications should resolve the artifact, then add their own adapter.

The same rule applies to cross-provider reasoning blocks. A signed Anthropic
thinking block is not an OpenAI reasoning Item. Provider-native reasoning can
only be replayed to its originating provider unless an application deliberately
defines a lossy conversion.

No encoder silently filters unsupported content.

## Adding another provider

1. Normalize provider output into canonical blocks.
2. Preserve the exact raw response or an artifact reference.
3. Carry requested and served model identities separately.
4. Distinguish end, tool use, length, pause, refusal, cancellation, and error.
5. Record cache-read, cache-write, and reasoning usage separately.
6. Preserve unknown blocks.
7. Make unsupported outbound blocks throw.
8. Add official response fixtures and round-trip tests.
