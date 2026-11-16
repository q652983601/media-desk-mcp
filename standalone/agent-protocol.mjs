// Small, original CLI adapters. JSONL / ACP, never an interactive terminal.
import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'

export function agentError(code, message) {
  return Object.assign(new Error(message), { code, status: code === 'AGENT_BUSY' ? 409 : 502 })
}

function processFailure(agent, code, stderr) {
  if ((agent === 'minimax' && code === 3) || /not logged in|authentication|unauthorized|auth.required|please log.?in|login required|invalid.*credential|no api key|not authenticated/i.test(stderr)) {
    return agentError('AGENT_AUTH_REQUIRED', `${agent} 尚未登录或登录已失效；请在运行服务的电脑上使用官方 CLI 完成登录。`)
  }
  if (/unexpected argument|unknown option|unrecognized argument|unknown command/i.test(stderr)) {
    return agentError('AGENT_UNSUPPORTED_CLI', `${agent} 当前版本不支持所需的非交互协议；请检查官方 CLI 版本。`)
  }
  return agentError('AGENT_EXIT', `${agent} CLI 未成功完成（退出码 ${code ?? 'unknown'}）；未切换其他提供方。`)
}

function codexProtocol({ finish, fail }) {
  let answer = null
  let completed = false
  return {
    start(send, input, prompt) { input.end(prompt) },
    message(frame) {
      if (frame.type === 'item.completed' && frame.item?.type === 'agent_message' && typeof frame.item.text === 'string') {
        answer = frame.item.text
      }
      if (frame.type === 'turn.failed' || frame.type === 'error') {
        fail(agentError('AGENT_TURN_FAILED', 'Codex 本轮生成失败；未返回半成品或切换提供方。'))
      }
      if (frame.type === 'turn.completed') completed = true
    },
    eof() {
      if (!completed || !answer?.trim()) throw agentError('AGENT_INCOMPLETE', 'Codex 未返回完整的 turn.completed 与最终正文。')
      finish(answer, false)
    },
    cancel() {},
  }
}

function claudeProtocol({ finish }) {
  let answer = null
  return {
    document: true,
    start(_send, input, prompt) { input.end(prompt) },
    message(frame) {
      if (frame.type !== 'result' || frame.subtype !== 'success' || frame.is_error || typeof frame.result !== 'string' || !frame.result.trim()) {
        throw agentError('AGENT_INCOMPLETE', 'Claude 未返回成功的完整正文。')
      }
      answer = frame.result
    },
    eof() {
      if (!answer) throw agentError('AGENT_INCOMPLETE', 'Claude 未返回完整结果。')
      finish(answer, false)
    },
    cancel() {},
  }
}

function minimaxProtocol({ finish }) {
  let answer = null
  return {
    document: true,
    start(_send, input, prompt) { input.end(JSON.stringify([{ role: 'user', content: prompt }])) },
    message(frame) {
      if (frame.stop_reason !== 'end_turn' || !Array.isArray(frame.content)) {
        throw agentError('AGENT_INCOMPLETE', 'MiniMax 未完整结束本轮生成。')
      }
      answer = frame.content.filter(block => block.type === 'text' && typeof block.text === 'string').map(block => block.text).join('')
      if (!answer.trim()) throw agentError('AGENT_INCOMPLETE', 'MiniMax 未返回正文。')
    },
    eof() {
      if (!answer) throw agentError('AGENT_INCOMPLETE', 'MiniMax 未返回完整结果。')
      finish(answer, false)
    },
    cancel() {},
  }
}

function kimiProtocol({ finish, fail, send, endInput, cwd, model }) {
  let stage = 'initialize'
  let sessionId = null
  let text = ''
  let expectedId = 1
  const request = (method, params) => send({ jsonrpc: '2.0', id: expectedId, method, params })
  const promptRequest = (prompt) => {
    stage = 'prompt'
    expectedId += 1
    request('session/prompt', { sessionId, prompt: [{ type: 'text', text: prompt }] })
  }
  let promptText = ''
  let modelOptionId = null
  return {
    start(_send, _input, prompt) {
      promptText = prompt
      request('initialize', {
        protocolVersion: 1,
        clientInfo: { name: 'media-desk', version: '0.1.0' },
        // Advertise implemented denial handlers. Omitting these capabilities
        // makes Kimi fall back to local text IO / shell execution.
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: true },
      })
    },
    message(frame) {
      if (frame.jsonrpc !== '2.0') throw agentError('AGENT_PROTOCOL', 'Kimi 返回了无效的 ACP JSON-RPC 消息。')
      if (frame.method && frame.id !== undefined) {
        if (frame.method === 'session/request_permission') {
          send({ jsonrpc: '2.0', id: frame.id, result: { outcome: { outcome: 'cancelled' } } })
        } else {
          // No filesystem, terminal, elicitation, or arbitrary host services.
          send({ jsonrpc: '2.0', id: frame.id, error: { code: -32001, message: 'Media Desk text generation does not grant host tool access.' } })
        }
        return
      }
      if (frame.method === 'session/update') {
        if (frame.params?.sessionId !== sessionId) return
        const update = frame.params?.update
        if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') {
          text += update.content.text
        }
        return
      }
      if (frame.method) return
      if (frame.id !== expectedId) throw agentError('AGENT_PROTOCOL', 'Kimi ACP 响应的请求编号不匹配。')
      if (frame.error) {
        const auth = frame.error.code === -32000 || /auth|login|credential/i.test(String(frame.error.message ?? ''))
        throw agentError(auth ? 'AGENT_AUTH_REQUIRED' : 'AGENT_PROTOCOL', auth
          ? 'Kimi 尚未登录或账号未就绪；请在运行服务的电脑上使用官方 CLI 完成登录。'
          : `Kimi ACP 未完成 ${stage}；当前 CLI 或配置不支持所需协议，未退回自动批准模式。`)
      }
      const result = frame.result
      if (!result || typeof result !== 'object') throw agentError('AGENT_PROTOCOL', 'Kimi ACP 缺少有效的 result。')
      if (stage === 'initialize') {
        if (result.protocolVersion !== 1) throw agentError('AGENT_UNSUPPORTED_CLI', 'Kimi ACP 协议版本不受支持。')
        stage = 'session'
        expectedId += 1
        request('session/new', { cwd, mcpServers: [] })
      } else if (stage === 'session') {
        if (typeof result.sessionId !== 'string' || !result.sessionId || result.sessionId.length > 512) {
          throw agentError('AGENT_PROTOCOL', 'Kimi 未返回有效的 ACP 会话。')
        }
        sessionId = result.sessionId
        modelOptionId = result.configOptions?.find(option => option.category === 'model' && typeof option.id === 'string')?.id ?? null
        if (!result.modes?.availableModes?.some(mode => mode.id === 'default')) {
          throw agentError('AGENT_UNSUPPORTED_CLI', 'Kimi 未声明可显式选择的 default/manual 模式；不会启动自动批准会话。')
        }
        stage = 'mode'
        expectedId += 1
        request('session/set_mode', { sessionId, modeId: 'default' })
      } else if (stage === 'mode') {
        if (model !== 'default') {
          stage = 'model'
          expectedId += 1
          if (modelOptionId) request('session/set_config_option', { sessionId, configId: modelOptionId, value: model })
          else request('session/set_model', { sessionId, modelId: model })
        } else promptRequest(promptText)
      } else if (stage === 'model') {
        promptRequest(promptText)
      } else if (stage === 'prompt') {
        if (result.stopReason !== 'end_turn' || !text.trim()) {
          throw agentError('AGENT_INCOMPLETE', 'Kimi 未完整结束本轮或没有返回正文；没有采用截断结果。')
        }
        stage = 'finished'
        finish(text, true)
        endInput()
      }
    },
    eof() {
      if (stage !== 'finished') throw agentError('AGENT_INCOMPLETE', 'Kimi ACP 在生成完成前断开。')
    },
    cancel() {
      if (sessionId) send({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId } })
    },
  }
}

/** Run one official CLI using bounded stdio. No prompt or raw stderr is logged. */
export function runAgentProcess({ agent, command, args, cwd, env, prompt, model, signal, timeoutMs, maxOutputBytes }) {
  if (signal?.aborted) return Promise.reject(agentError('AGENT_CANCELLED', `${agent} 生成已取消。`))
  return new Promise((resolve, reject) => {
    let child
    let protocol
    let error = null
    let answer = null
    let completedACP = false
    let requestedShutdown = false
    let settled = false
    let bytes = 0
    let buffer = ''
    let stderr = ''
    const decoder = new StringDecoder('utf8')
    const timers = new Set()
    const later = (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer }
    const kill = (sig) => {
      if (!child?.pid) return
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, sig)
        else child.kill(sig)
      } catch { /* already exited */ }
    }
    const settle = (code = null) => {
      if (settled) return
      settled = true
      for (const timer of timers) clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      child?.stdin?.destroy()
      if (error) reject(error)
      else if (answer !== null && (code === 0 || requestedShutdown)) resolve({ text: answer })
      else reject(processFailure(agent, code, stderr))
    }
    const stop = () => {
      requestedShutdown = completedACP && !error
      kill('SIGTERM')
      later(() => kill('SIGKILL'), 400)
      later(() => {
        child?.stdout?.destroy()
        child?.stderr?.destroy()
        settle()
      }, 1500)
    }
    const fail = (reason) => {
      if (settled || error) return
      error = reason
      try { protocol?.cancel() } catch { /* termination still proceeds */ }
      stop()
    }
    const onAbort = () => fail(agentError('AGENT_CANCELLED', `${agent} 生成已取消。`))
    const send = (frame) => {
      if (settled || child?.stdin?.destroyed || !child?.stdin?.writable) return
      child.stdin.write(`${JSON.stringify(frame)}\n`)
    }
    const finish = (text, stopOnSuccess) => {
      answer = text
      completedACP = stopOnSuccess
      if (stopOnSuccess) later(stop, 750)
    }
    const consume = (line) => {
      if (!line.trim() || error || settled) return
      try {
        const frame = JSON.parse(line)
        if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('object required')
        protocol.message(frame)
      } catch (reason) {
        fail(reason?.code?.startsWith('AGENT_') ? reason : agentError('AGENT_PROTOCOL', `${agent} 返回了无效的结构化输出；没有把日志当成正文。`))
      }
    }
    const count = (chunk) => {
      bytes += chunk.length
      if (bytes > maxOutputBytes) {
        fail(agentError('AGENT_OUTPUT_LIMIT', `${agent} 输出超过配置上限，已停止本次生成。`))
        return false
      }
      return !error && !settled
    }
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (reason) {
      reject(agentError('AGENT_START_FAILED', `${agent} CLI 无法启动。`))
      return
    }
    const protocols = { codex: codexProtocol, kimi: kimiProtocol, claude: claudeProtocol, minimax: minimaxProtocol }
    protocol = protocols[agent]({
      finish, fail, send, endInput: () => child.stdin.end(), cwd, model,
    })
    child.on('error', reason => {
      error = agentError(reason.code === 'ENOENT' ? 'AGENT_NOT_FOUND' : 'AGENT_START_FAILED', `${agent} CLI 未安装或配置的可执行文件无法启动。`)
      settle()
    })
    child.stdin.on('error', reason => {
      if (reason.code !== 'EPIPE') fail(agentError('AGENT_STDIN', `${agent} CLI 输入通道断开。`))
    })
    child.stdout.on('data', chunk => {
      if (!count(chunk)) return
      buffer += decoder.write(chunk)
      if (protocol.document) return
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        consume(line)
      }
    })
    child.stderr.on('data', chunk => {
      if (!count(chunk)) return
      if (stderr.length < 8192) stderr += chunk.toString('utf8').slice(0, 8192 - stderr.length)
    })
    child.on('close', code => {
      if (settled) return
      buffer += decoder.end()
      if (buffer.trim()) consume(buffer)
      if (!error && (code === 0 || requestedShutdown)) {
        try { protocol.eof() } catch (reason) { error = reason }
      }
      settle(code)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    later(() => fail(agentError('AGENT_TIMEOUT', `${agent} 生成超时，已终止进程；未自动重试。`)), timeoutMs)
    if (signal?.aborted) onAbort()
    else {
      try { protocol.start(send, child.stdin, prompt) } catch (reason) { fail(reason) }
    }
  })
}
