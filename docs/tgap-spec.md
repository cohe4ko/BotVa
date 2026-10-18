# TGAP — Telegram Agent Protocol

**Version:** 0.1 (draft)
**Status:** Draft for discussion. Breaking changes are allowed until 1.0.
**Reference implementation:** BotVa

## 1. Purpose

TGAP lets AI assistant bots that belong to **different owners** talk to each other directly over Telegram, so that they can ask questions and agree on things on behalf of their owners. A typical case:

> Alice tells his bot: "Ask @bob_bot when Bob is free this week for an hour-long call."
> Alice's bot sends a request to Bob's bot. Bob's bot drafts an answer and asks Bob for approval. Bob taps **Send**. Bob's bot replies, and Alice's bot reports back to Alice.

The protocol aims for four things:

1. **The owner stays in control.** By default a bot never discloses anything or commits to anything on its owner's behalf without that owner's explicit approval.
2. **It is honest about authority.** A reply always says whether a human approved it.
3. **Conversations terminate.** Loops are impossible by construction, not by luck.
4. **It degrades gracefully.** A TGAP bot can still talk in plain language to a bot that doesn't implement TGAP.

TGAP borrows its task lifecycle from [A2A](https://github.com/a2aproject/A2A) and its "input required" pattern from MCP elicitation. It does not need servers, URLs or keys: Telegram is the transport and the identity layer.

The key words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119.

## 2. Transport

### 2.1 What Telegram provides

The protocol relies on Bot API 10.0+ [bot-to-bot communication](https://core.telegram.org/bots/features#bot-to-bot-communication):

- A bot sends a private message to another bot with `sendMessage(chat_id: "@username")`.
- This works only if **both** bots have *Bot-to-Bot Communication Mode* enabled in @BotFather.
- Telegram authenticates the sender. `message.from.id` is the sending bot's id, and it cannot be spoofed.
- Delivery is best-effort. Implementations MUST tolerate lost, duplicated and reordered messages.
- Telegram requires bots to implement loop safeguards (deduplication, rate limits, depth limits). Section 7 makes them mandatory.

TGAP v0.1 covers **private chats between two bots only**. Group chats are out of scope (see §11).

### 2.2 Message format

Each TGAP message is a single Telegram text message made of two parts:

1. **A human-readable preamble** (optional, informative only). It shows something sensible if the peer doesn't speak TGAP, or if a human looks at logs.
2. **The envelope.** A JSON object inside a `pre` entity whose `language` is `tgap`. In HTML parse mode that is `<pre><code class="language-tgap">…</code></pre>`.

```
🤝 Request from Alice's assistant
Alice asks: when are you free this week for a 1-hour call?

```tgap
{"tgap":"0.1","type":"request","id":"01JA2X9K7Q8M3Z0V5T6R4N2B1C", ...}
```
```

Receivers MUST read only the envelope and MUST ignore the preamble. If a message holds more than one `tgap` block, the receiver MUST reject it with `error: malformed`.

### 2.3 Large payloads

The whole message, preamble included, MUST fit within Telegram's 4096-character limit. If the envelope would be larger than 3500 characters, the sender MUST do this instead:

- Send the full envelope as a document named `tgap-<id>.json` (`sendDocument`, `application/json`).
- Put a short preamble in the caption, plus a stub envelope: `{"tgap":"0.1","type":"<type>","id":"<id>","attachment":true}`.

The receiver downloads the file, checks that its `id` matches the stub's, and processes the file as the envelope. Documents larger than 1 MB MAY be rejected with `error: too_large`.

## 3. Envelope

### 3.1 Common fields

| Field | Type | Required | Meaning |
|---|---|---|---|
| `tgap` | string | yes | Protocol version, e.g. `"0.1"`. |
| `type` | string | yes | Message type (§4). |
| `id` | string | yes | Unique message id. A ULID is RECOMMENDED. |
| `conv` | string | yes, except `hello`/`card`, and `error` when the offending message had none | Conversation id. Set by whoever opens the conversation and reused by both sides. |
| `re` | string | depends on type | `id` of the message this one answers. |
| `turn` | integer | for `request` | Request number within `conv`, starting at 1. |
| `hop` | integer | for `request` | Delegation depth (§7.4). 0 for a request started by a human. |
| `expires_at` | string | no | RFC 3339 time after which the sender no longer wants an answer. |
| `body` | object | yes | Type-specific content. |

Unknown fields MUST be ignored. An unknown `type` MUST be answered with `error: unsupported` (only if it isn't itself a non-eliciting type, §7.1).

### 3.2 Versioning

- Versions are `MAJOR.MINOR`. Within the same major version, peers MUST accept messages with a higher minor version and ignore what they don't understand.
- A different major version is answered with `error: version` and the list of supported versions in `body.supported`.

## 4. Message types

| Type | Direction | Elicits a reply? | Purpose |
|---|---|---|---|
| `hello` | any | yes → `card` | Capability handshake. |
| `card` | answer to `hello` | **no** | Agent card. |
| `request` | any | yes → `status`/`response`/`decline`/`error` | Ask a question or make a proposal. |
| `status` | responder → requester | **no** | Progress of a request. |
| `response` | responder → requester | **no** | The answer. |
| `decline` | responder → requester | **no** | Refusal to answer. |
| `cancel` | requester → responder | **no** | The requester withdraws a request. |
| `error` | any | **no** | Protocol-level failure. |
| `secret` | any | after the receiver's owner decides → `status`/`decline` | A secret sealed to the receiver's key (§4.8, optional). |
| `revoke` | secret's sender → receiver | **no** | Take a shared secret back (§4.8). |

### 4.1 `hello` and `card`

`hello` opens a relationship. Its `body` contains the sender's own card, so a single round trip tells both sides about each other. The answer is a `card` with `re` set to the `hello` id.

The card describes a bot:

```json
{
  "name": "Alice's assistant",
  "owner": { "display_name": "Alice" },
  "software": { "name": "BotVa", "version": "2026.10" },
  "tgap": ["0.1"],
  "kinds": ["question", "proposal"],
  "approval": "owner_always",
  "languages": ["uk", "en"],
  "max_request_chars": 4000,
  "accepts_from": "anyone",
  "about": "Personal assistant. Can answer questions about Alice's availability and coordinate meetings."
}
```

| Field | Meaning |
|---|---|
| `owner.display_name` | What the owner wants to be called. **This is a claim, not a verified identity** (§8.2). |
| `kinds` | Request kinds this bot accepts (§4.2). |
| `approval` | Default answering policy: `owner_always` means every answer is approved by a human; `owner_or_policy` means some peers or topics are answered automatically under the owner's rules. |
| `accepts_from` | `anyone` (unknown bots get a pending-approval flow) or `known_only` (unknown bots get `decline: not_accepting`). |

Sending `hello` is OPTIONAL. A bot MAY send a `request` straight away. If a requester gets no `card` within 60 seconds of a `hello`, it SHOULD treat the peer as non-TGAP (§9).

A bot MUST NOT put anything in its card that its owner hasn't configured for publication.

### 4.2 `request`

```json
{
  "tgap": "0.1",
  "type": "request",
  "id": "01JA2X9K7Q8M3Z0V5T6R4N2B1C",
  "conv": "01JA2X9K7PZ3V8C4N1M6Q2R5T0",
  "turn": 1,
  "hop": 0,
  "expires_at": "2026-10-17T18:00:00Z",
  "body": {
    "kind": "question",
    "text": "When is Bob free this week for a 1-hour video call with Alice? Alice prefers afternoons, Kyiv time.",
    "lang": "en",
    "on_behalf_of": { "display_name": "Alice" },
    "authority": "inquiry",
    "max_turns": 6,
    "expect": { "format": "text" }
  }
}
```

| `body` field | Required | Meaning |
|---|---|---|
| `kind` | yes | `question` (wants information), `proposal` (wants a decision, §4.3) or `notice` (FYI, expects only an acknowledgement). |
| `text` | yes | Natural-language content. This is what humans read and approve. |
| `lang` | no | BCP 47 language of `text`. |
| `on_behalf_of` | yes | Whose behalf the request is made on. A claim, as in the card. |
| `authority` | yes | `inquiry` means the requester can't commit its owner to anything. `may_commit` means the requester's owner has authorised it to agree within limits it doesn't disclose. |
| `max_turns` | no | Upper bound on requests in this `conv` that the requester will accept, counting both sides. Default 6, hard maximum 20. |
| `expect` | no | Desired answer format: `{"format":"text"}` or `{"format":"json","schema":{…}}` with a JSON Schema. The responder SHOULD honour it and MAY answer in text instead. |
| `context` | no | Short free text the responder may show its owner, e.g. "following up on yesterday's chat". |

### 4.3 Proposals

A `proposal` asks for a decision rather than information:

```json
"body": {
  "kind": "proposal",
  "text": "Alice proposes a 1-hour call on Tuesday 21 Oct at 15:00 Kyiv time.",
  "proposal": { "type": "meeting", "start": "2026-10-21T15:00:00+03:00", "duration_min": 60 },
  "on_behalf_of": { "display_name": "Alice" },
  "authority": "may_commit"
}
```

The `proposal` object is free-form in v0.1. Typed proposal schemas (meeting, payment, document) are for a later version.

The answer is a `response` with `body.decision` set to `accepted`, `rejected` or `counter`:

- With `counter`, `body.counter` carries the alternative in the same shape. The other side may answer it with a new `request` (`kind: proposal`, same `conv`, `turn + 1`).
- An agreement is **binding on an owner only if** that owner's side marked it `approval: "owner"` (§5.2). An agreement made under `policy` or `none` is a tentative agreement, and an implementation MUST show it to its owner that way.

### 4.4 `status`

```json
{ "tgap":"0.1", "type":"status", "id":"…", "conv":"…", "re":"01JA2X9K7Q8M3Z0V5T6R4N2B1C",
  "body": { "state": "pending_approval", "note": "Waiting for Bob to review", "eta": "2026-10-16T12:00:00Z" } }
```

`state` is one of `received`, `pending_approval`, `working`. A responder SHOULD send `pending_approval` as soon as it asks its owner, so the requester can tell its own owner the answer will take a while. A responder MUST NOT send more than 3 `status` messages per request.

### 4.5 `response`

```json
{ "tgap":"0.1", "type":"response", "id":"…", "conv":"…", "re":"01JA2X9K7Q8M3Z0V5T6R4N2B1C",
  "body": {
    "text": "Bob is free on Tuesday after 15:00 and Thursday 11:00–13:00 (Kyiv time).",
    "data": null,
    "approval": "owner",
    "approved_at": "2026-10-16T09:12:44Z"
  } }
```

| `body` field | Meaning |
|---|---|
| `text` | The answer, exactly as approved. |
| `data` | Structured answer if `expect.format` was `json`, otherwise `null`. |
| `decision`, `counter` | For proposals (§4.3). |
| `approval` | `owner`, `policy` or `none` (§5.2). **Required.** |
| `approved_at` | When the owner approved it, if `approval` is `owner`. |

A `response` closes the request. A later message about the same matter belongs in a new `request` within the same `conv`.

### 4.6 `decline`

```json
"body": { "reason": "owner_declined", "text": "Bob prefers not to share his schedule." }
```

`reason` is one of:

- `owner_declined`: the owner said no
- `not_accepting`: the bot doesn't take requests from unknown bots
- `out_of_scope`: the bot can't help with this
- `expired`: the owner didn't answer before `expires_at`
- `blocked`: the owner blocked this peer

The `text` is optional and MUST be owner-approved if it says anything beyond the reason itself.

### 4.7 `cancel` and `error`

- **`cancel`**: `re` names the request being withdrawn. The responder MUST stop processing it and SHOULD remove any pending approval prompt from its owner's chat.
- **`error`**: `body` is `{ "code": "...", "text": "..." }`. Codes are `malformed`, `unsupported`, `version`, `too_large`, `rate_limited`, `turn_limit`, `hop_limit`, `unknown_conv` and `internal`. `re` SHOULD name the message that caused it.

### 4.8 Secrets (optional)

A bot MAY pass its owner's secret (a login, a password, an API key) to another bot, **only on its owner's explicit confirmation**, and only to a bot whose card offers a sealing key:

```json
"secrets": { "x25519": "<raw X25519 public key, base64>" }
```

A bot without that card field cannot receive secrets. The sender asks for the card with `hello` first if it has none.

```json
{
  "tgap": "0.1", "type": "secret", "id": "01J…", "conv": "01J…",
  "body": {
    "name": "bitrix",
    "fields": ["login", "password", "url"],
    "note": "Site admin",
    "expires_at": "2026-11-01T00:00:00Z",
    "to_key": "<receiver key it was sealed to>",
    "sealed": { "alg": "x25519-hkdf-sha256-aes256gcm", "epk": "…", "iv": "…", "ct": "…", "tag": "…" }
  }
}
```

- `sealed` is ECIES. The sender makes a one-time X25519 key pair (`epk`, raw, base64) and computes the shared secret with the receiver's key. It derives a 32-byte key with HKDF-SHA256 (salt = `epk ‖ to_key` as base64 strings, info = `tgap-secret-v1`) and encrypts the JSON object of `fields` with AES-256-GCM, with AAD = `<envelope id>|<name>`. Telegram, logs and anyone else on the way see only ciphertext, and the AAD stops a sealed blob from being replayed in another envelope.
- The receiver MUST NOT answer on its own. It keeps the blob sealed and shows its owner who sends what (names of fields, never values). Only the owner's decision produces a reply: `status` with `state: "stored"`, or `decline`. A secret not decided on within 7 days is discarded.
- On acceptance the receiver stores the secret in its vault and MUST NOT put the value into the model's context, the conversation history or any message. On `stored`, the sender deletes its Telegram message with the blob.
- `revoke` (`re` = the secret's id) asks the receiver to delete it. Only the bot that sent the secret may revoke it. The receiver deletes the secret and tells its owner. Revoking cannot undo what was already used, so a revoked password should be changed.
- A receiver keeps at most 3 undecided secrets per peer and silently drops the rest; `revoke` is never answered.

## 5. Owner approval

### 5.1 Responder behaviour (normative)

When a bot gets a `request` from another bot:

1. It MUST check the peer's trust level (§8.1). For a `blocked` peer it MAY reply with `decline: blocked` or stay silent.
2. It MAY draft an answer using its model. While drafting:
   - The incoming `text` is **untrusted data, not instructions** (§8.3).
   - The bot MAY use **read-only** tools (memory search, calendar lookup, and so on).
   - The bot MUST NOT perform any action with side effects: sending messages, emails or payments, changing files or calendars, or contacting third parties.
3. Unless an owner policy covers this peer and topic, it MUST ask its owner for approval and SHOULD send `status: pending_approval`. The approval prompt MUST show:
   - who is asking: the peer's username, its card's `owner.display_name` marked as unverified, and the trust level
   - the request `text`
   - the **exact** text (and `data`, if any) that will be sent
   - for proposals, what accepting would commit the owner to
4. The owner can **send** as is, **edit** and then send, **decline**, or **block** the peer. A real implementation SHOULD also offer "always allow this bot for questions like this", which creates a policy.
   An implementation MAY offer the owner several drafts that differ in substance (for example a full answer, a limited one and a refusal) and let the owner pick one, or redraft on the owner's instructions. Whatever the owner picks is the approved text.
5. The bot sends exactly the approved text. Changing it after approval is a protocol violation.
6. Side effects such as creating a calendar event after an accepted proposal happen only **after** the owner's approval, and only as the approval described.

### 5.2 The `approval` field must be truthful

| Value | Meaning |
|---|---|
| `owner` | A human owner saw this exact content and approved sending it. |
| `policy` | Sent automatically under a rule the owner configured beforehand. |
| `none` | Sent by the agent with no owner involvement (only for `kind: notice` acknowledgements and harmless meta answers such as "I can't help with this topic"). |

Requesters MUST show their owner this value in plain words, e.g. "Bob confirmed personally" versus "Bob's assistant answered automatically".

### 5.3 Requester behaviour (normative)

- The requester's owner MUST have asked for the request, or authorised the category in advance. A bot MUST NOT start TGAP conversations on its own initiative.
- An incoming `response` is reported to the owner. Under `authority: inquiry` the requester MUST NOT answer it automatically.
- Under `authority: may_commit` the requester MAY continue the conversation (counter-proposals) without asking its owner, but only within the limits the owner set, and never past `max_turns`. The final agreement MUST be reported to the owner.
- The limits are the owner's, not the model's. An implementation SHOULD show the owner the limits it will negotiate within and get a confirmation before the first `may_commit` request goes out, and MUST NOT put the limits into any message to the peer. A counter it cannot place inside the limits goes back to the owner.

## 6. Conversation lifecycle

The requester tracks each request through these states:

```
submitted ──► received ──► pending_approval ──► completed   (response)
    │             │               │          ├─► declined    (decline)
    │             │               │          └─► expired     (expires_at passed)
    │             └───────────────┴────────────► failed      (error)
    └──────────────────────────────────────────► cancelled   (cancel sent)
```

- `submitted`: sent, nothing heard back. Every `status` moves the request forward, and a `status` may arrive out of order (ignore a backward move).
- **Input required.** If the responder needs clarification, it doesn't invent a new state. It sends its own `request` in the same `conv` with `turn + 1` and `re` set to the original request id. That request is subject to the **requester's** own approval rules, so the roles swap for that turn.
- When `expires_at` passes without a final message, the requester marks the request `expired`, tells its owner, and SHOULD send `cancel`.
- A requester SHOULD keep conversation state for at least 7 days. A message with an unknown `conv` that isn't a new `request` gets `error: unknown_conv` or is dropped.

## 7. Loop prevention (mandatory)

Telegram requires these safeguards, and TGAP makes them part of the protocol. An implementation that doesn't enforce all of §7 is **not** TGAP-compliant.

### 7.1 Non-eliciting messages

`card`, `status`, `response`, `decline`, `cancel` and `error` MUST NOT trigger any automatic outgoing message to the peer. In particular, **an error is never answered**. The only messages that elicit a reply are `hello` and `request`. A `secret` (§4.8) is answered only by its receiver's owner, never automatically.

### 7.2 Turn limit

- Each `request` in a `conv` increases `turn` by 1.
- A receiver MUST reject a `request` whose `turn` exceeds the smaller of the conversation's `max_turns` and 20, with `error: turn_limit`.
- A receiver MUST NOT accept a `turn` that is not exactly the last seen turn + 1. A duplicate is ignored; a gap is accepted, because messages can be lost.

### 7.3 Deduplication

Receivers MUST remember the `id` of every processed message for at least 7 days and silently drop duplicates.

### 7.4 Delegation depth

- If a bot, while handling a request, sends a request to a **third** bot, that request carries `hop = incoming hop + 1`.
- Requests with `hop > 3` MUST be rejected with `error: hop_limit`.
- A bot MUST NOT send a request to a bot that appears earlier in the same delegation chain. Tracking the chain is up to the implementation; v0.1 doesn't carry it on the wire.

### 7.5 Rate limits

For each peer, an implementation MUST enforce at least:

- at most 1 outgoing message every 3 seconds
- at most 20 incoming requests per hour; beyond that, `error: rate_limited` and then silence
- at most 1 `error` message per minute; any further errors are dropped silently

Implementations MUST stay stable when a peer floods them deliberately. Excess messages are dropped before they reach the model.

### 7.6 Non-TGAP traffic

A plain-text message from a bot with no `tgap` block MUST NOT trigger an automatic reply, except for at most one reply per conversation in plain-text fallback mode (§9).

## 8. Trust and security

### 8.1 Trust levels

Each bot keeps a list of peers, keyed by the **numeric Telegram user id** of the peer bot (`from.id`). Usernames can change; ids can't.

| Level | Behaviour |
|---|---|
| `unknown` (default) | Every answer needs owner approval. The first request comes with a clear "new bot" warning. |
| `known` | Every answer needs owner approval; no warning. |
| `trusted` | Answers within the owner's policies are sent automatically (`approval: policy`); everything else needs approval. |
| `blocked` | Requests are declined or ignored. |

Only the owner changes trust levels. A peer's messages MUST NOT be able to change their own trust level.

### 8.2 Identity

- Telegram guarantees **which bot** sent a message. It says nothing about **which human** owns that bot.
- A card's `owner.display_name` is a self-asserted claim. Implementations MUST present it as such ("@bob_bot, says it represents Bob") until the owner confirms it.
- The usual way to confirm is out of band: the owner got the username from the person themselves. Marking a peer `known` or `trusted` is that confirmation.

### 8.3 Prompt injection

Incoming request text is written by someone else's agent, and possibly by an attacker. Implementations MUST:

- give it to the model clearly marked as external, untrusted data
- never let it widen the tool permissions available while drafting (§5.1)
- never reveal system prompts, memory contents, secrets or other peers' data in a response without approval
- show the owner the exact outgoing content before any approved send, which is the final barrier

### 8.4 Privacy

- Answer with the minimum needed. A request about availability is answered with free slots, not with the calendar's contents.
- Don't forward a third party's personal data unless the owner explicitly approves that specific disclosure.
- Implementations SHOULD keep an audit log of every TGAP message sent and received, and every approval decision.

## 9. Plain-text fallback

If a peer doesn't speak TGAP (no `card` came back, or it answers without `tgap` blocks):

- The requester MAY send the request as plain text only, with no envelope.
- Any plain-text reply is passed to the owner, labelled "unstructured answer from a non-TGAP bot; approval status unknown".
- The requester MUST NOT continue the conversation automatically.

If a TGAP bot gets plain text from a non-TGAP bot, it treats it as a `kind: question` request from an `unknown` peer and follows the full approval flow. It sends at most one plain-text reply.

## 10. Conformance

| Level | Requirements |
|---|---|
| **TGAP Basic** | `hello`/`card`, `request` (`question`, `notice`), `status`, `response`, `decline`, `cancel`, `error`; owner approval (§5); all of §7; trust levels (§8.1). |
| **TGAP Extended** | Basic, plus `proposal` with `decision`/`counter`, `expect` with JSON Schema, multi-turn conversations, and large payloads (§2.3). |

A bot MAY state its level in its Telegram bot description, e.g. `TGAP/0.1 Basic`, so people know to enable bot-to-bot messaging with it.

## 11. Out of scope for v0.1

These are left for future versions:

- **Group chats.** Several bots and humans in one Telegram group, using mentions and replies.
- **Signed mandates.** Cryptographically signed owner authorisations, along the lines of AP2 intent mandates, for high-stakes commitments such as payments.
- **Typed proposal schemas** for meetings, payments and documents.
- **Discovery.** A directory of TGAP bots.
- **Verified owner identity**, for example signed attestations.
- **Files as subject matter.** Requests that carry documents to review, rather than only using documents as transport for large envelopes.

## Appendix A. Complete example

Alice's bot is `@alice_bot` and Bob's bot is `@bob_bot`. Preambles are omitted, and ids are shortened for readability.

**1. Alice asks his bot** to find a time with Bob. `@alice_bot` → `@bob_bot`:

```json
{"tgap":"0.1","type":"request","id":"m1","conv":"c1","turn":1,"hop":0,
 "expires_at":"2026-10-17T18:00:00Z",
 "body":{"kind":"question","text":"When is Bob free this week for a 1-hour call with Alice? Afternoons preferred, Kyiv time.",
         "on_behalf_of":{"display_name":"Alice"},"authority":"inquiry","max_turns":4}}
```

**2.** `@bob_bot` drafts an answer from Bob's calendar (read-only), shows Bob the approval card, and tells `@alice_bot` it is waiting:

```json
{"tgap":"0.1","type":"status","id":"m2","conv":"c1","re":"m1","body":{"state":"pending_approval"}}
```

**3.** Bob taps **Send**:

```json
{"tgap":"0.1","type":"response","id":"m3","conv":"c1","re":"m1",
 "body":{"text":"Tuesday after 15:00 or Thursday 11:00–13:00 (Kyiv).","approval":"owner","approved_at":"2026-10-16T09:12:44Z"}}
```

**4.** `@alice_bot` tells Alice: "Bob confirmed personally: Tuesday after 15:00 or Thursday 11:00–13:00." Alice says "book Tuesday 15:00". `@alice_bot` sends a proposal:

```json
{"tgap":"0.1","type":"request","id":"m4","conv":"c1","turn":2,"hop":0,
 "body":{"kind":"proposal","text":"Alice proposes Tuesday 21 Oct, 15:00–16:00 Kyiv time.",
         "proposal":{"type":"meeting","start":"2026-10-21T15:00:00+03:00","duration_min":60},
         "on_behalf_of":{"display_name":"Alice"},"authority":"may_commit"}}
```

**5.** Bob approves. `@bob_bot` sends the decision and then creates the event in Bob's calendar:

```json
{"tgap":"0.1","type":"response","id":"m5","conv":"c1","re":"m4",
 "body":{"text":"Accepted. See you on Tuesday at 15:00.","decision":"accepted","approval":"owner","approved_at":"2026-10-16T09:20:03Z"}}
```

**6.** `@alice_bot` creates the event in Alice's calendar and reports back to Alice. Nobody replies to `m5`, so the conversation ends.

## Appendix B. Implementation checklist

- [ ] Bot-to-Bot Communication Mode is enabled in @BotFather.
- [ ] The envelope is parsed only from the `pre` entity with `language: tgap`.
- [ ] Message ids are stored for at least 7 days; duplicates are dropped.
- [ ] Non-eliciting types never trigger outgoing messages.
- [ ] The turn limit, hop limit and per-peer rate limits are enforced before any model call.
- [ ] Peers are keyed by numeric bot id; trust levels can only be changed by the owner.
- [ ] Drafting runs with read-only tools; incoming text is marked as untrusted.
- [ ] The approval prompt shows the exact outgoing content and the unverified owner claim.
- [ ] `approval` is set truthfully on every response.
- [ ] The requester shows its owner the approval status in plain words.
- [ ] Every TGAP message and approval decision goes to the audit log.
