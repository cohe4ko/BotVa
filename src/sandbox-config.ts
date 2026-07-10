import type { Options } from '@anthropic-ai/claude-agent-sdk'

/**
 * Opt-in SDK sandbox with credential masking (query option `options.sandbox`).
 *
 * The masking mechanism is a sub-feature of the sandbox: it only works when the
 * sandbox is enabled, because the sentinel→real substitution happens at the
 * sandbox network proxy. So `buildSandboxSettings()` always sets `enabled: true`.
 *
 * `mode: 'mask'` shows sandboxed Bash commands a sentinel value instead of the
 * real key, and the host proxy swaps sentinel→real only on egress to that
 * credential's `injectHosts`. Each injectHosts entry must be reachable via
 * `network.allowedDomains` (sandbox-runtime validates this), so we build the
 * network allowlist from the union of all masked credentials' hosts.
 *
 * Only vars actually present in the environment are masked — there is nothing to
 * mask for a var that the subprocess never sees.
 */

export type SandboxSettings = NonNullable<Options['sandbox']>

// Sensitive env var → host(s) where its real value may be injected on egress.
// Covers the keys this project can use plus the common providers named in the
// integration task; the presence filter keeps it harmless when a var is absent.
const CREDENTIAL_HOSTS: Record<string, string[]> = {
  GROQ_API_KEY: ['api.groq.com'],
  GROQ_API_KEYS: ['api.groq.com'],
  GEMINI_API_KEY: ['generativelanguage.googleapis.com'],
  GOOGLE_API_KEY: ['generativelanguage.googleapis.com'],
  OPENAI_API_KEY: ['api.openai.com'],
  ELEVENLABS_API_KEY: ['api.elevenlabs.io'],
  ANTHROPIC_API_KEY: ['api.anthropic.com'],
  TELEGRAM_BOT_TOKEN: ['api.telegram.org'],
}

/**
 * Build the `options.sandbox` value for an opt-in sandboxed run. Returns a
 * settings object that enables the sandbox and masks whichever sensitive vars
 * are present in `env`. Callers gate on the SANDBOX_ENABLED flag — this function
 * assumes the operator already opted in.
 */
export function buildSandboxSettings(env: NodeJS.ProcessEnv = process.env): SandboxSettings {
  const envVars: NonNullable<NonNullable<SandboxSettings['credentials']>['envVars']> = []
  const hosts = new Set<string>()

  for (const [name, injectHosts] of Object.entries(CREDENTIAL_HOSTS)) {
    if (!env[name]) continue
    envVars.push({ name, mode: 'mask', injectHosts })
    for (const h of injectHosts) hosts.add(h)
  }

  const settings: SandboxSettings = {
    enabled: true,
    // Graceful degradation: if the sandbox can't start (missing deps or
    // unsupported platform) warn and run unsandboxed instead of hard-failing.
    failIfUnavailable: false,
  }

  // Only add credential masking + the network allowlist it requires when there
  // is actually something to mask; otherwise leave the sandbox's default
  // network model untouched.
  if (envVars.length > 0) {
    settings.credentials = { envVars }
    settings.network = { allowedDomains: [...hosts] }
  }

  return settings
}
