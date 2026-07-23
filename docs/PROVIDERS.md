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

`fromOpenAIChatCompletion()` also covers OpenAI-compatible aggregators such as
OpenRouter: it reads the `reasoning` field OpenRouter uses (alongside
DeepSeek-style `reasoning_content`) and records OpenRouter's `usage.cost` as
`telemetry.costUsd`, which the built-in telemetry projection aggregates.

## Encoding

`toOpenAIInput()` emits Responses API input Items. Assistant output messages,
function calls, reasoning items, and function-call outputs remain distinct
items. This follows OpenAI’s documented mapping:

- [Responses migration: map messages to Items](https://developers.openai.com/api/docs/guides/migrate-to-responses#2-map-messages-to-items)
- [Responses API reference](https://developers.openai.com/api/reference/resources/responses/methods/create)

`toAnthropicInput()` emits a top-level `system` string and alternating
user/assistant messages. Canonical tool-role messages become Anthropic user
messages containing `tool_result` blocks. The loop journals one tool-role
message per tool result, but Anthropic expects every `tool_result` answering
one assistant turn in a single user message — splitting them suppresses
parallel tool use — so consecutive tool-role messages merge into one user
message, preserving result order:

- [Anthropic Messages API](https://platform.claude.com/docs/en/api/messages/create)
- [Anthropic tool results](https://platform.claude.com/docs/en/agents-and-tools/tool-use/handle-tool-calls)

Anthropic accepts image blocks inside `tool_result` content. A canonical image
block in a tool result encodes to its native base64 source block when the block
retained that source in `providerMetadata.raw`; text-only results stay a plain
string.

### Passing images (and files) to the model

Image and file blocks carry an `ArtifactRef`, not bytes. The encoders are
synchronous and cannot read the artifact store, so resolve the bytes first with
`inlineArtifactBytes(messages, artifacts)` — it fetches each block's bytes
(including images nested inside tool results) and attaches base64 that the
encoders emit as a provider image payload. Call it in the `ModelInvoker` before
encoding.

Where an image may appear differs by provider, and the encoders follow each
API's real rules:

- **Anthropic** accepts an image inside `tool_result` content and inside user
  messages. A tool that returns an image is passed straight back to the model
  after inlining — no restructuring needed.
- **OpenAI Chat Completions and Responses** cannot place an image in a tool
  message. The tool result must stay text, and the image is relayed as a
  following `user` message, where inlining produces an `image_url` (Chat) or
  `input_image` (Responses) content part. Attempting to encode an image inside
  an OpenAI tool result throws with that guidance.

Files follow the same reference model; there is no built-in provider mapping
for file blocks yet, so they stay unencodable (or `describe` placeholders)
until an application adapter encodes them.

OpenAI bills image input by tiles, so a single image can cost a large number of
input tokens at the default `auto` fidelity. The encoders send a proper
`image_url`/`input_image` (not base64 text), whose token count responds to the
`detail` field. Pass `{ imageDetail: "low" }` to the OpenAI encoders to send a
fixed low-resolution image and reduce those tokens when exact detail is not
needed; `"high"` forces full tiling. Anthropic has no equivalent knob, so
`imageDetail` is ignored there.

`toOpenAIChatInput()` emits the Chat Completions `messages` shape used by
OpenRouter and most OpenAI-compatible endpoints: assistant tool calls become
`tool_calls` entries with JSON-string arguments, and each canonical tool
result becomes its own `role: "tool"` message keyed by `tool_call_id`.
`toOpenAIChatTools()` encodes `ToolDefinition`s for the same requests.
Reasoning blocks have no Chat Completions input form and follow the
fail-loud/downgrade policy below.

## Streaming

Streaming is a live projection, never durable state: the loop journals only
the complete normalized response, so a consumer that missed the stream loses
nothing durable.

- `runAgentLoop({ onModelStream })` forwards `ModelStreamEvent`s (text,
  reasoning, and tool-call deltas) from the invoker to the host with the
  current turn ID; the invoker sees the sink as `request.onStream`.
- `sseJsonEvents(responseBody)` parses an SSE byte stream into JSON chunks,
  skipping comment heartbeats and ending on `[DONE]`.
- `createChatCompletionStreamAccumulator()` folds OpenAI-style chunks
  (OpenRouter included) into the complete non-streaming response shape while
  emitting stream events. Feed the accumulated `response()` to
  `fromOpenAIChatCompletion()` and return that from the invoker.

See [`examples/openrouter-streaming.ts`](../examples/openrouter-streaming.ts)
for the full composition against the live OpenRouter API. Anthropic SDK users
stream via the SDK's own accumulation and normalize the final message with
`fromAnthropicMessage()`, forwarding `request.onStream` events from the SDK's
delta callbacks.

## Fail-loud boundary

Artifacts contain bytes, while provider image/file inputs require a URL,
provider file ID, or base64 payload. The kernel cannot invent that mapping.
Therefore the built-in encoders throw `ProviderEncodingError` for image/file
blocks whose native payload is unavailable. Applications should resolve the
artifact, then add their own adapter.

The same rule applies to cross-provider reasoning blocks. A signed Anthropic
thinking block is not an OpenAI reasoning Item. Provider-native reasoning can
only be replayed to its originating provider unless an application deliberately
defines a lossy conversion.

No encoder silently filters unsupported content.

## Explicit downgrades

Both encoders accept an options argument with `unencodable: "throw" |
"describe"`. The default, `"throw"`, keeps the fail-loud boundary above. With
`"describe"`, a block the target provider cannot express is replaced by a
deterministic text placeholder naming the block type and any artifact
reference it carried, for example:

```
[unencodable image block: sha256:9f2c…]
```

This is an explicit, auditable downgrade — the transcript states what was
dropped — not a silent omission, so it is the supported way to keep encoding a
journal that contains provider-native reasoning after switching providers, or
tool results with unresolved image/file artifacts. Structural errors (invalid
canonical envelopes, malformed tool arguments, blocks on impossible roles)
still throw under either setting.

## Adding another provider

1. Normalize provider output into canonical blocks.
2. Preserve the exact raw response or an artifact reference.
3. Carry requested and served model identities separately.
4. Distinguish end, tool use, length, pause, refusal, cancellation, and error.
5. Record cache-read, cache-write, and reasoning usage separately.
6. Preserve unknown blocks.
7. Make unsupported outbound blocks throw by default; honor
   `unencodable: "describe"` with the same placeholder shape.
8. Add official response fixtures and round-trip tests.
