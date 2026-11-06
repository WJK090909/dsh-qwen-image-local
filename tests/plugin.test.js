import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../index.js'

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0])

function mount(config, cwd) {
  const definitions = new Map()
  const ctx = {
    tools: { register(tool) { definitions.set(tool.name, tool); return () => definitions.delete(tool.name) } },
    workingDirectory: { get() { return cwd } },
    effect(factory) { return factory() },
  }
  apply(ctx, config)
  return definitions
}

function execution() {
  return { signal: new AbortController().signal, agent: { session: {} } }
}

test('OpenAI Images protocol saves a returned PNG under the session directory', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qwen-plugin-'))
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'http://127.0.0.1:8000/v1/images/generations')
    const request = JSON.parse(options.body)
    assert.equal(request.model, 'qwen-image')
    assert.equal(request.size, '1024x1024')
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), { status: 200 })
  }
  try {
    const tool = mount({ protocol: 'openai', baseUrl: 'http://127.0.0.1:8000/v1', model: 'qwen-image', apiKey: '', outputDir: '.images', timeoutMs: 5000, autoStart: false }, cwd).get('generate_qwen_image')
    const result = await tool.execute({ prompt: 'a red fox' }, execution())
    assert.equal(result.mimeType, 'image/png')
    assert.equal((await readFile(result.path)).toString('hex'), png.toString('hex'))
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true, force: true })
  }
})

test('ComfyUI protocol updates configured prompt and size inputs', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qwen-plugin-'))
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), body: options.body ? JSON.parse(options.body) : undefined })
    if (String(url).endsWith('/prompt')) return new Response(JSON.stringify({ prompt_id: 'job-1' }), { status: 200 })
    if (String(url).includes('/history/')) return new Response(JSON.stringify({ 'job-1': { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } } } }), { status: 200 })
    if (String(url).includes('/view?')) return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } })
    throw new Error(`Unexpected request: ${url}`)
  }
  try {
    const workflow = {
      '6': { inputs: { text: '' } },
      '7': { inputs: { width: 512, height: 512 } },
    }
    const tool = mount({
      protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188', outputDir: '.images', timeoutMs: 5000, autoStart: false,
      comfyWorkflow: JSON.stringify(workflow), promptNodeId: '6', promptInput: 'text',
      widthNodeId: '7', widthInput: 'width', heightNodeId: '7', heightInput: 'height',
      negativeNodeId: '', negativeInput: 'text',
    }, cwd).get('generate_qwen_image')
    await tool.execute({ prompt: 'a red fox', width: 768, height: 512 }, execution())
    assert.equal(requests[0].body.prompt['6'].inputs.text, 'a red fox')
    assert.equal(requests[0].body.prompt['7'].inputs.width, 768)
    assert.equal(requests[0].body.prompt['7'].inputs.height, 512)
  } finally {
    globalThis.fetch = originalFetch
    await rm(cwd, { recursive: true, force: true })
  }
})

test('autoStart launches the service on the first call and then generates', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qwen-plugin-'))
  const port = 47831
  const serverScript = join(cwd, 'server.cjs')
  const pngBytes = png.toString('base64')
  await writeFile(serverScript, `
const http = require('http')
const payload = JSON.stringify({ data: [{ b64_json: ${JSON.stringify(pngBytes)} }] })
const server = http.createServer((req, res) => {
  if (req.url.includes('/images/generations')) {
    res.setHeader('content-type', 'application/json')
    res.end(payload)
    setTimeout(() => server.close(() => process.exit(0)), 300)
    return
  }
  res.end('{"object":"list","data":[]}')
})
server.listen(${port}, '127.0.0.1')
`, 'utf8')

  try {
    const tool = mount({
      protocol: 'openai',
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: 'qwen-image',
      apiKey: '',
      outputDir: '.images',
      timeoutMs: 20000,
      autoStart: true,
      launchCommand: `"${process.execPath}" "${serverScript}"`,
      launchCwd: cwd,
      readyTimeoutMs: 20000,
    }, cwd).get('generate_qwen_image')
    const result = await tool.execute({ prompt: 'a red fox' }, execution())
    assert.equal(result.mimeType, 'image/png')
    assert.equal((await readFile(result.path)).toString('hex'), png.toString('hex'))
  } finally {
    // The spawned helper keeps the temp directory busy until it exits on Windows.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        await rm(cwd, { recursive: true, force: true })
        break
      } catch (error) {
        if (attempt === 19) throw error
        await new Promise(resolve => setTimeout(resolve, 250))
      }
    }
  }
})

test('setup tool reports local install status and exposes an install option when ComfyUI is absent', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'qwen-plugin-'))
  try {
    const tools = mount({ protocol: 'comfyui', baseUrl: 'http://127.0.0.1:47999', autoStart: false }, cwd)
    const setup = tools.get('qwen_image_setup')
    assert.ok(setup)
    const result = await setup.execute({ action: 'status' }, execution())
    assert.ok(['ready', 'model-files-missing', 'comfyui-missing'].includes(result.status))
    assert.equal(typeof result.message, 'string')
    assert.equal(typeof result.comfyuiPath, 'string')
    assert.equal(typeof result.modelPath, 'string')
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
})
