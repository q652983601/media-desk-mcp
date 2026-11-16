// CLI runtime definitions + a shared bounded process adapter. No agent framework.
import { accessSync, constants, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { agentError, runAgentProcess } from './agent-protocol.mjs'

export const AGENT_DEFINITIONS = {
  codex: {
    name: 'Codex CLI', protocol: 'codex-exec-jsonl',
    args: model => [
      'exec', '--json', '--ephemeral', '--sandbox', 'read-only',
      '--skip-git-repo-check', '--ignore-user-config',
      '-c', 'approval_policy="never"',
      ...(model === 'default' ? [] : ['--model', model]),
    ],
  },
  kimi: { name: 'Kimi CLI', protocol: 'acp-json-rpc', args: () => ['acp'] },
  claude: {
    name: 'Claude Code', protocol: 'claude-print-json',
    args: model => [
      '--print', '--output-format', 'json', '--no-session-persistence',
      '--safe-mode', '--tools', '', '--strict-mcp-config',
      '--mcp-config', '{"mcpServers":{}}',
      ...(model === 'default' ? [] : ['--model', model]),
    ],
  },
  minimax: {
    name: 'MiniMax CLI (mmx)', command: 'mmx', protocol: 'minimax-messages-json',
    args: model => [
      'text', 'chat', '--messages-file', '-', '--output', 'json', '--non-interactive',
      ...(model === 'default' ? [] : ['--model', model]),
    ],
  },
}

// Account state stays with the official CLI. Do not copy credential files or
// forward unrelated service tokens / API keys from the Media Desk daemon.
const ENV_KEYS = [
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL',
  'SYSTEMROOT', 'SystemRoot', 'COMSPEC', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'CODEX_HOME', 'KIMI_CODE_HOME', 'KIMI_HOME', 'CLAUDE_CONFIG_DIR',
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS',
]

function childEnvironment(env, id) {
  const providerKeys = {
    claude: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL'],
    minimax: ['MINIMAX_API_KEY', 'MINIMAX_REGION', 'MINIMAX_BASE_URL'],
  }
  const keys = [...ENV_KEYS, ...(providerKeys[id] ?? [])]
  return { ...Object.fromEntries(keys.filter(key => typeof env[key] === 'string').map(key => [key, env[key]])), NO_COLOR: '1', TERM: 'dumb' }
}

export function findExecutable(command, env) {
  if (!command || command.includes('\0')) return null
  const candidates = isAbsolute(command) || command.includes('/') || command.includes('\\')
    ? [resolve(command)]
    : String(env.PATH ?? '').split(delimiter).filter(Boolean).map(directory => join(directory, command))
  for (const path of candidates) {
    try {
      accessSync(path, constants.X_OK)
      if (statSync(path).isFile()) return path
    } catch { /* try next PATH entry */ }
  }
  return null
}

function boundedNumber(value, fallback, min, max, key) {
  if (value === undefined || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${key} must be an integer between ${min} and ${max}`)
  return number
}

function promptFor({ system, user, maxTokens }) {
  if (typeof system !== 'string' || typeof user !== 'string') throw agentError('AGENT_INPUT', 'Agent 输入必须包含文本 system 与 user。')
  const tokenHint = Number.isInteger(maxTokens) && maxTokens > 0 ? ` Keep the final response within approximately ${Math.min(maxTokens, 32768)} tokens.` : ''
  const prompt = `Produce the requested content for Media Desk using only the supplied material. Do not call tools, browse, read or write files, run commands, or ask interactive questions. Return the requested final content only.${tokenHint}\n\n[Writing instructions]\n${system}\n\n[Request and material]\n${user}`
  if (Buffer.byteLength(prompt, 'utf8') > 256 * 1024) throw agentError('AGENT_INPUT_LIMIT', 'Agent 输入超过 256 KiB，请缩短素材。')
  return prompt
}

/**
 * Explicitly opted-in official CLIs, compatible with createModelServices().
 * Presence is not a login or real-model verification. Selection never falls back.
 */
export function createAgentModelConfigs(env = process.env) {
  const selected = [...new Set(String(env.MEDIA_DESK_AGENTS ?? '').split(',').map(value => value.trim()).filter(Boolean))]
  if (!selected.length) return []
  for (const id of selected) if (!Object.hasOwn(AGENT_DEFINITIONS, id)) throw new Error(`Unsupported MEDIA_DESK_AGENTS entry: ${id}`)
  const timeoutMs = boundedNumber(env.MEDIA_DESK_AGENT_TIMEOUT_MS, 180_000, 100, 600_000, 'MEDIA_DESK_AGENT_TIMEOUT_MS')
  const maxOutputBytes = boundedNumber(env.MEDIA_DESK_AGENT_MAX_OUTPUT_BYTES, 2 * 1024 * 1024, 1024, 16 * 1024 * 1024, 'MEDIA_DESK_AGENT_MAX_OUTPUT_BYTES')
  const workRoot = resolve(env.MEDIA_DESK_AGENT_WORKDIR || join(tmpdir(), 'media-desk-agent-work'))
  return selected.flatMap(id => {
    const definition = AGENT_DEFINITIONS[id]
    const prefix = `MEDIA_DESK_${id.toUpperCase()}`
    const commandName = String(env[`${prefix}_COMMAND`] || definition.command || id)
    const command = findExecutable(commandName, env)
    const rawModels = env[`${prefix}_MODELS`] || env[`${prefix}_MODEL`] || 'default'
    const models = [...new Set(String(rawModels).split(',').map(value => value.trim()).filter(Boolean))]
    if (!models.length || models.some(model => model.length > 160 || !/^[\w./:@+-]+$/.test(model))) throw new Error(`${prefix}_MODELS contains an invalid model identifier`)
    let active = false
    const agentStatus = {
      installed: Boolean(command), authenticated: 'unverified', protocol: definition.protocol,
      reason: command ? 'CLI found; account and real generation have not been verified.' : `CLI not found; install ${id} or set ${prefix}_COMMAND to its executable path.`,
    }
    return models.map(model => ({
      provider: id, name: definition.name, model, agentStatus,
      async generate(input) {
        if (!command) throw agentError('AGENT_NOT_FOUND', `${definition.name} 未安装；请设置 ${prefix}_COMMAND 为官方 CLI 可执行文件路径。`)
        if (input.signal?.aborted) throw agentError('AGENT_CANCELLED', `${definition.name} 生成已取消。`)
        if (active) throw agentError('AGENT_BUSY', `${definition.name} 正在处理另一条内容，请稍后重试。`)
        const prompt = promptFor(input)
        active = true
        let cwd
        try {
          await mkdir(workRoot, { recursive: true, mode: 0o700 })
          cwd = await mkdtemp(join(workRoot, `${id}-`))
          return await runAgentProcess({
            agent: id, command, args: definition.args(model), cwd, env: childEnvironment(env, id),
            prompt, model, signal: input.signal, timeoutMs, maxOutputBytes,
          })
        } finally {
          if (cwd) await rm(cwd, { recursive: true, force: true }).catch(() => {})
          active = false
        }
      },
    }))
  })
}
