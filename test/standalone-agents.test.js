import assert from 'node:assert/strict'
import { access, chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { createAgentModelConfigs } from '../standalone/agents.mjs'

const input = { system: 'Return JSON.', user: 'Write a title.', maxTokens: 300 }
const emitCodex = text => `console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: ${JSON.stringify(text)} } })); console.log(JSON.stringify({ type: 'turn.completed' }));`

async function fixture(t, body, agent = 'codex', extras = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'media-desk-agent-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const command = join(directory, `${agent} fixture.mjs`)
  await writeFile(command, `#!/usr/bin/env node\n${body}\n`)
  await chmod(command, 0o700)
  const work = join(directory, 'isolated-work')
  const env = {
    ...process.env,
    MEDIA_DESK_AGENTS: agent,
    MEDIA_DESK_AGENT_WORKDIR: work,
    MEDIA_DESK_AGENT_TIMEOUT_MS: '3000',
    [`MEDIA_DESK_${agent.toUpperCase()}_COMMAND`]: command,
    ...extras,
  }
  return { config: createAgentModelConfigs(env)[0], directory, work, env }
}

test('CLI integrations are off by default; explicit configs do not pretend to verify accounts', () => {
  assert.deepEqual(createAgentModelConfigs({}), [])
  assert.throws(() => createAgentModelConfigs({ MEDIA_DESK_AGENTS: 'unknown' }), /Unsupported/)
  const configs = createAgentModelConfigs({ MEDIA_DESK_AGENTS: 'codex,kimi', PATH: '', MEDIA_DESK_CODEX_MODELS: 'default,custom-model' })
  assert.deepEqual(configs.map(row => [row.provider, row.model]), [['codex', 'default'], ['codex', 'custom-model'], ['kimi', 'default']])
  assert.ok(configs.every(row => row.agentStatus.authenticated === 'unverified' && !row.agentStatus.installed))
})

test('missing CLI returns an actionable error without an API fallback', async () => {
  const config = createAgentModelConfigs({ MEDIA_DESK_AGENTS: 'kimi', PATH: '' })[0]
  await assert.rejects(config.generate(input), { code: 'AGENT_NOT_FOUND' })
  const directory = createAgentModelConfigs({ MEDIA_DESK_AGENTS: 'codex', MEDIA_DESK_CODEX_COMMAND: tmpdir() })[0]
  assert.equal(directory.agentStatus.installed, false)
})

test('Codex uses read-only ephemeral argv, pipes literal input and strips unrelated credentials', async t => {
  const { config, directory, work } = await fixture(t, `
    import { readFileSync } from 'node:fs';
    const prompt = readFileSync(0, 'utf8');
    const text = JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), prompt, hasApiKey: !!process.env.OPENAI_API_KEY, hasGitToken: !!process.env.GITHUB_TOKEN, home: process.env.HOME });
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'intermediate text' } }));
    console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text } }));
    console.log(JSON.stringify({ type: 'turn.completed' }));
  `, 'codex', { OPENAI_API_KEY: 'test-secret', GITHUB_TOKEN: 'test-secret', MEDIA_DESK_CODEX_MODELS: 'test-model' })
  const marker = join(directory, 'must-not-exist')
  const user = `literal $(touch ${marker}); echo injected`
  const result = JSON.parse((await config.generate({ ...input, user })).text)
  assert.equal(result.hasApiKey, false)
  assert.equal(result.hasGitToken, false)
  assert.equal(result.home, process.env.HOME)
  assert.ok(result.argv.includes('--json') && result.argv.includes('--ephemeral'))
  assert.equal(result.argv[result.argv.indexOf('--sandbox') + 1], 'read-only')
  assert.ok(result.argv.includes('approval_policy="never"'))
  assert.equal(result.argv[result.argv.indexOf('--model') + 1], 'test-model')
  assert.ok(result.argv.every(value => !/dangerously|yolo/.test(value)))
  assert.ok(result.prompt.includes(user))
  assert.ok(result.cwd.startsWith(work + '/codex-'))
  await assert.rejects(access(marker))
  assert.deepEqual(await readdir(work), [])
})

test('Codex requires a completed turn and rejects failed or corrupt protocol output', async t => {
  const scenarios = [
    [`console.log('not JSON');`, 'AGENT_PROTOCOL'],
    [`console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'partial'}}));`, 'AGENT_INCOMPLETE'],
    [`console.log(JSON.stringify({type:'turn.failed',error:{message:'secret diagnostic'}}));`, 'AGENT_TURN_FAILED'],
    [`${emitCodex('partial')} process.exitCode = 2;`, 'AGENT_EXIT'],
  ]
  for (const [body, code] of scenarios) {
    const { config } = await fixture(t, body)
    await assert.rejects(config.generate(input), error => error.code === code && !error.message.includes('secret diagnostic'))
  }
})

test('nonzero auth errors are explained without exposing stderr', async t => {
  const { config } = await fixture(t, `process.stderr.write('Authentication failed token=test-secret'); process.exitCode = 1;`)
  await assert.rejects(config.generate(input), error => error.code === 'AGENT_AUTH_REQUIRED' && !error.message.includes('test-secret'))
})

test('output flood is bounded and the isolated work directory is cleaned', async t => {
  const { config, work } = await fixture(t, `process.stdout.write('x'.repeat(8192)); setInterval(() => {}, 1000);`, 'codex', { MEDIA_DESK_AGENT_MAX_OUTPUT_BYTES: '1024' })
  await assert.rejects(config.generate(input), { code: 'AGENT_OUTPUT_LIMIT' })
  assert.deepEqual(await readdir(work), [])
})

test('cancellation stops an active CLI and releases its busy state', async t => {
  const { config, directory, work } = await fixture(t, `setInterval(() => {}, 1000);`)
  const controller = new AbortController()
  const pending = config.generate({ ...input, signal: controller.signal })
  await assert.rejects(config.generate(input), { code: 'AGENT_BUSY' })
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, { code: 'AGENT_CANCELLED' })
  assert.deepEqual(await readdir(work), [])
  const command = join(directory, 'codex fixture.mjs')
  await writeFile(command, `#!/usr/bin/env node\n${emitCodex('after cancellation')}\n`)
  assert.equal((await config.generate(input)).text, 'after cancellation')
})

test('an unresponsive process is terminated at the configured timeout', async t => {
  const { config, work } = await fixture(t, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`, 'codex', { MEDIA_DESK_AGENT_TIMEOUT_MS: '150' })
  const started = Date.now()
  await assert.rejects(config.generate(input), { code: 'AGENT_TIMEOUT' })
  assert.ok(Date.now() - started < 2500)
  assert.deepEqual(await readdir(work), [])
})

test('Claude print JSON uses stdin, disables tools, and requires a successful final result', async t => {
  const { config } = await fixture(t, `
    import { readFileSync } from 'node:fs';
    const result = JSON.stringify({ prompt: readFileSync(0, 'utf8'), argv: process.argv.slice(2), miniMaxKey: process.env.MINIMAX_API_KEY });
    console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result}, null, 2));
  `, 'claude', { MINIMAX_API_KEY: 'fixture-private', MEDIA_DESK_CLAUDE_MODELS: 'sonnet' })
  const output = JSON.parse((await config.generate(input)).text)
  assert.ok(output.prompt.includes(input.user))
  assert.ok(output.argv.includes('--safe-mode') && output.argv.includes('--strict-mcp-config'))
  assert.equal(output.argv[output.argv.indexOf('--tools') + 1], '')
  assert.equal(output.argv[output.argv.indexOf('--model') + 1], 'sonnet')
  assert.equal(output.miniMaxKey, undefined)
  const failed = await fixture(t, `console.log(JSON.stringify({type:'result',subtype:'error_max_turns',is_error:true,result:'partial'}));`, 'claude')
  await assert.rejects(failed.config.generate(input), { code: 'AGENT_INCOMPLETE' })
})

test('MiniMax mmx reads message JSON from stdin and extracts only final text blocks', async t => {
  const { config } = await fixture(t, `
    import { readFileSync } from 'node:fs';
    const messages = JSON.parse(readFileSync(0, 'utf8'));
    const text = JSON.stringify({messages,argv:process.argv.slice(2),hasClaudeKey:!!process.env.ANTHROPIC_API_KEY,hasOwnKey:!!process.env.MINIMAX_API_KEY});
    console.log(JSON.stringify({stop_reason:'end_turn',content:[{type:'thinking',thinking:'private'},{type:'text',text}]}, null, 2));
  `, 'minimax', { ANTHROPIC_API_KEY: 'fixture-other', MINIMAX_API_KEY: 'fixture-own', MEDIA_DESK_MINIMAX_MODELS: 'MiniMax-M2.7' })
  const output = JSON.parse((await config.generate(input)).text)
  assert.ok(output.messages[0].content.includes(input.user))
  assert.ok(output.argv.includes('--messages-file') && output.argv.includes('--non-interactive'))
  assert.ok(!output.argv.includes('--quiet'))
  assert.equal(output.hasClaudeKey, false)
  assert.equal(output.hasOwnKey, true)
  const truncated = await fixture(t, `console.log(JSON.stringify({stop_reason:'max_tokens',content:[{type:'text',text:'partial'}]}));`, 'minimax')
  await assert.rejects(truncated.config.generate(input), { code: 'AGENT_INCOMPLETE' })
})

const kimiFixture = (options = {}) => `
  import { createInterface } from 'node:readline';
  const options = ${JSON.stringify(options)};
  const send = frame => console.log(JSON.stringify({jsonrpc:'2.0', ...frame}));
  let capabilities, cwd, model, promptId, permission, deniedIO = false;
  function done() {
    send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'private thoughts'}}}});
    send({method:'session/update',params:{sessionId:'fixture-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:JSON.stringify({capabilities,cwd,model,permission,deniedIO,argv:process.argv.slice(2)})}}}});
    send({id:promptId,result:{stopReason:options.stopReason || 'end_turn'}});
    if (options.failAfterAnswer) process.exitCode = 2;
  }
  createInterface({input:process.stdin}).on('line', line => {
    const frame = JSON.parse(line);
    if (frame.method === 'initialize') {
      capabilities = frame.params.clientCapabilities;
      send({id:frame.id,result:{protocolVersion:1,agentInfo:{name:'Kimi Code CLI',version:'fixture'},agentCapabilities:{}}});
    } else if (frame.method === 'session/new') {
      cwd = frame.params.cwd;
      if (options.authError) return send({id:frame.id,error:{code:-32000,message:'auth required; token=test-secret'}});
      send({id:frame.id,result:{sessionId:'fixture-session',modes:{currentModeId:'default',availableModes:[{id:options.unsafeMode?'auto':'default'}]}}});
    } else if (frame.method === 'session/set_mode') {
      if (frame.params.modeId !== 'default') process.exit(7);
      send({id:frame.id,result:{}});
    } else if (frame.method === 'session/set_model') {
      model = frame.params.modelId;
      send({id:frame.id,result:{}});
    } else if (frame.method === 'session/prompt') {
      promptId = frame.id;
      if (options.permission) send({id:400,method:'session/request_permission',params:{sessionId:'fixture-session',options:[{optionId:'allow',kind:'allow_once'}]}});
      else done();
    } else if (frame.id === 400) {
      permission = frame.result?.outcome?.outcome;
      send({id:401,method:'fs/read_text_file',params:{sessionId:'fixture-session',path:'/private/data'}});
    } else if (frame.id === 401) {
      deniedIO = frame.error?.code === -32001;
      done();
    }
  });
`

test('Kimi uses ACP, explicitly selects manual mode and denies tool/IO requests', async t => {
  const { config, work } = await fixture(t, kimiFixture({ permission: true }), 'kimi', { MEDIA_DESK_KIMI_MODELS: 'test-model' })
  const result = JSON.parse((await config.generate(input)).text)
  assert.deepEqual(result.argv, ['acp'])
  assert.equal(result.model, 'test-model')
  assert.equal(result.permission, 'cancelled')
  assert.equal(result.deniedIO, true)
  assert.deepEqual(result.capabilities, { fs: { readTextFile: true, writeTextFile: true }, terminal: true })
  assert.ok(result.cwd.startsWith(work + '/kimi-'))
  assert.deepEqual(await readdir(work), [])
})

test('Kimi never downgrades to auto mode or accepts a truncated turn', async t => {
  const scenarios = [[{ unsafeMode: true }, 'AGENT_UNSUPPORTED_CLI'], [{ stopReason: 'max_tokens' }, 'AGENT_INCOMPLETE'], [{ authError: true }, 'AGENT_AUTH_REQUIRED'], [{ failAfterAnswer: true }, 'AGENT_EXIT']]
  for (const [options, code] of scenarios) {
    const { config } = await fixture(t, kimiFixture(options), 'kimi')
    await assert.rejects(config.generate(input), error => error.code === code && !error.message.includes('test-secret'))
  }
})

test('pre-cancelled and oversized requests never launch a CLI', async t => {
  const { config, work } = await fixture(t, `throw new Error('must not launch');`)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(config.generate({ ...input, signal: controller.signal }), { code: 'AGENT_CANCELLED' })
  await assert.rejects(config.generate({ ...input, user: 'x'.repeat(256 * 1024) }), { code: 'AGENT_INPUT_LIMIT' })
  await assert.rejects(access(work))
})
