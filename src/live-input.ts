/**
 * Streaming input for one agent run.
 *
 * Instead of a string prompt, the SDK gets an async iterable that stays open
 * while the run is alive. A message the user sends while the agent works is
 * pushed into it and reaches the model at the next step boundary — the
 * running tool is not interrupted, and nothing already done is thrown away.
 *
 * Keeping the input open is also what lets background tasks survive: with a
 * closed input the CLI kills them as soon as the turn ends. So the input is
 * closed only once the run is idle — no turn running and no background task
 * left (see LiveRun in agent.ts).
 */

import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'

export class LiveInput implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = []
  private wake: (() => void) | undefined
  private closed = false

  /** Called after every push — the run uses it to mark a turn as running. */
  onPush?: () => void

  get isClosed(): boolean {
    return this.closed
  }

  /** Queue a user message. Returns false once the input is closed. */
  push(text: string): boolean {
    if (this.closed) return false
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    } as SDKUserMessage)
    this.onPush?.()
    this.wake?.()
    return true
  }

  /**
   * Stop accepting messages. Messages already queued are still handed to the
   * SDK first, and the CLI answers them before it exits.
   */
  close(): void {
    this.closed = true
    this.wake?.()
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const next = this.queue.shift()
      if (next) {
        yield next
        continue
      }
      if (this.closed) return
      await new Promise<void>(r => { this.wake = r })
      this.wake = undefined
    }
  }
}
