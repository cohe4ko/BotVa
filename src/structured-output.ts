/**
 * Structured outputs (Agent SDK `outputFormat`) for the calls that expect JSON.
 *
 * With a schema the model's answer arrives already parsed in
 * `result.structured_output`, so a stray fence or a chatty preamble can no
 * longer break the parse. The callers keep their own validation and their old
 * text parsing as a fallback; this only hands them the best payload available.
 */

import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export type JsonSchema = Record<string, unknown>

export function jsonOutput(schema: JsonSchema): { type: 'json_schema'; schema: JsonSchema } {
  return { type: 'json_schema', schema }
}

/** The structured payload of a successful result message, if the SDK produced one. */
export function structuredOf(ev: SDKMessage): unknown {
  if (ev.type !== 'result' || ev.subtype !== 'success') return undefined
  return (ev as { structured_output?: unknown }).structured_output
}

/**
 * The JSON text a result stands for: the structured output re-serialised when
 * present, otherwise the model's plain result text.
 */
export function resultPayload(ev: SDKMessage): string {
  if (ev.type !== 'result') return ''
  const so = structuredOf(ev)
  if (so !== undefined && so !== null) return JSON.stringify(so)
  return ev.subtype === 'success' ? ev.result : (ev.errors?.join('\n') ?? 'Error')
}

// --- schemas shared by more than one caller ---

const str = { type: 'string' }
const strArray = { type: 'array', items: str }

/** One extracted item for the listener transcript analysis. */
const listenerItem = {
  type: 'object',
  properties: { text: str, topic: str, tags: str, time: str },
  required: ['text', 'topic', 'tags'],
}

/** src/listener-analyze.ts → AnalysisResult */
export const LISTENER_ANALYSIS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    facts: { type: 'array', items: listenerItem },
    decisions: { type: 'array', items: listenerItem },
    tasks: { type: 'array', items: listenerItem },
    topics: strArray,
    summary: str,
    language: str,
    transcriptQuality: { type: 'string', enum: ['good', 'poor', 'garbage'] },
    suggestedLanguage: { type: ['string', 'null'] },
  },
  required: ['facts', 'decisions', 'tasks', 'topics', 'summary', 'language', 'transcriptQuality', 'suggestedLanguage'],
}

const conversationItem = {
  type: 'object',
  properties: {
    text: str, quote: str, who: str, confidence: { type: 'number' },
    when_due: { type: ['string', 'null'] }, topic: str, tags: str,
    msg_ids: { type: 'array', items: { type: 'integer' } },
  },
  required: ['text', 'quote', 'who', 'confidence', 'when_due', 'topic', 'tags', 'msg_ids'],
}

/** src/telegram/analyze-conversation.ts — one array per ITEM_KINDS entry. */
export const CONVERSATION_ANALYSIS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: Object.fromEntries(
    ['facts', 'events', 'commitments_mine', 'commitments_theirs', 'requests', 'dates', 'contacts']
      .map(k => [k, { type: 'array', items: conversationItem }]),
  ),
  required: ['facts', 'events', 'commitments_mine', 'commitments_theirs', 'requests', 'dates', 'contacts'],
}

/** src/admin/routes/bot-facts.ts — facts rebuilt from a knowledge file. */
export const REBUILT_FACTS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { content: str, topic: str, tags: str, sector: { type: 'string', enum: ['semantic', 'episodic', 'preference'] } },
        required: ['content', 'topic', 'tags', 'sector'],
      },
    },
  },
  required: ['facts'],
}

/**
 * The two admin diagnostics. Their prompts spell out the full structure and the
 * pages render it; the schema pins the top level and guarantees valid JSON
 * without fighting the prompt over every nested field.
 */
export const BOT_DIAGNOSTICS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    tools: { type: 'array', items: { type: 'object' } },
    mcpServers: strArray,
    systemInstructions: str,
    role: str,
    knowledge: strArray,
    model: { type: ['string', 'null'] },
    skills: { type: 'array', items: { type: 'object' } },
    recommendations: { type: 'array', items: { type: 'object' } },
    canDisable: { type: 'array', items: { type: 'object' } },
    stats: { type: 'object' },
  },
  required: ['tools', 'mcpServers', 'systemInstructions', 'role', 'knowledge', 'model', 'skills', 'recommendations', 'canDisable', 'stats'],
}

export const SYSTEM_DIAGNOSTICS_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    summary: str,
    issues: { type: 'array', items: { type: 'object' } },
    recommendations: { type: 'array', items: { type: 'object' } },
  },
  required: ['score', 'summary', 'issues', 'recommendations'],
}
