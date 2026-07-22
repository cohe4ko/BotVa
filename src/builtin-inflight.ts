// Tracks how many builtin MCP tool handlers are currently executing.
//
// Builtin tools run in the host process but are invoked by the agent CLI
// subprocess over an SDK stream. A soft interrupt (q.interrupt() on follow-up)
// closes the consumer side of that stream; any builtin tool call still in flight
// then fails with "Stream closed by consumer" (error code 138) — the result
// never reaches the model even though the handler's side effect already ran
// (e.g. SaveFact wrote the row, but the model sees an error and retries).
//
// This counter lets the request queue drain in-flight builtin calls before
// issuing an interrupt, so their results are delivered first.

let count = 0

export const builtinInFlight = {
  enter(): void {
    count++
  },
  exit(): void {
    count = Math.max(0, count - 1)
  },
  count(): number {
    return count
  },
}
