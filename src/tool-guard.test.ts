import { describe, it, expect } from 'vitest'
import { directBotApiViolation, toolGuardHook, DIRECT_BOT_API_REASON } from './tool-guard.js'

const ROOT = '/srv/botva'
const bash = (command: string) => directBotApiViolation('Bash', { command }, ROOT)

describe('directBotApiViolation — Bash', () => {
  it('blocks a curl to the Bot API with the token from .env (what a bot actually did)', () => {
    const cmd = "cd bots/cap && T=$(grep '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2-) && curl -s https://api.telegram.org/bot$T/sendMessage -d chat_id=@other_bot -d text=hi"
    expect(bash(cmd)).toBe(DIRECT_BOT_API_REASON)
  })

  it('blocks a literal token and the ${VAR} form', () => {
    expect(bash('curl https://api.telegram.org/bot123456789:AAEabc/getMe')).not.toBeNull()
    expect(bash('curl "https://api.telegram.org/bot${TOKEN}/getUpdates"')).not.toBeNull()
    expect(bash('wget https://api.telegram.org/file/bot$T/photos/x.jpg')).not.toBeNull()
  })

  it('blocks the token variable fed to an HTTP client', () => {
    expect(bash('python3 -c "import os,requests; requests.post(url, os.environ[\'TELEGRAM_BOT_TOKEN\'])"')).not.toBeNull()
  })

  it('leaves ordinary commands alone', () => {
    expect(bash('ls -la && git status')).toBeNull()
    expect(bash('curl -s https://api.github.com/repos/x/y')).toBeNull()
    expect(bash('grep -rn "api.telegram.org" src')).toBeNull()
    expect(bash("grep -c '^TELEGRAM_BOT_TOKEN=' .env")).toBeNull()
  })
})

describe('directBotApiViolation — files', () => {
  it('blocks a script outside the platform code that calls the Bot API with a token', () => {
    const content = 'import os, requests\nrequests.post(f"https://api.telegram.org/bot{os.environ[\'T\']}/sendMessage")'
    expect(directBotApiViolation('Write', { file_path: '/srv/botva/bots/cap/send.py', content }, ROOT)).not.toBeNull()
    expect(directBotApiViolation('Edit', { file_path: '/tmp/x.sh', new_string: 'curl https://api.telegram.org/bot$T/x' }, ROOT)).not.toBeNull()
  })

  it('allows edits to the platform code itself (a developer bot working on BotVa)', () => {
    const content = 'const res = await fetch(`https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${path}`)'
    expect(directBotApiViolation('Edit', { file_path: '/srv/botva/src/tgap/runtime.ts', new_string: content }, ROOT)).toBeNull()
    expect(directBotApiViolation('Write', { file_path: '/srv/botva/scripts/x.sh', content }, ROOT)).toBeNull()
  })

  it('ignores other tools', () => {
    expect(directBotApiViolation('Read', { file_path: '/srv/botva/bots/cap/.env' }, ROOT)).toBeNull()
  })
})

describe('toolGuardHook', () => {
  it('returns a block decision with the reason, or nothing', async () => {
    const hook = toolGuardHook(ROOT)
    expect(await hook({ tool_name: 'Bash', tool_input: { command: 'curl https://api.telegram.org/bot$T/getMe' } })).toEqual({ decision: 'block', reason: DIRECT_BOT_API_REASON })
    expect(await hook({ tool_name: 'Bash', tool_input: { command: 'ls' } })).toEqual({})
  })
})
