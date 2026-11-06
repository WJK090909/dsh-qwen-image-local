import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'qwen-image-local'
export const inject = ['tools', 'workingDirectory']

const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url))
const INSTALL_SCRIPT = join(PLUGIN_DIR, 'scripts', 'install-comfyui.ps1')
const MODEL_LAYOUTS = [
  { root: 'D:\\\\AI-Models\\\\Qwen-Image-2.1-UC', diffusion: 'diffusion_models\\\\qwen-image-2.1-UC-Q4_K_M.gguf', encoder: 'text_encoders\\\\qwen3vl_8b_int8_convrot.safetensors', vae: 'vae\\\\qwen_image_2.1_vae_bf16.safetensors' },
  { root: 'C:\\\\AI-Models\\\\Qwen-Image-2.1-UC', diffusion: 'diffusion_models\\\\qwen-image-2.1-UC-Q4_K_M.gguf', encoder: 'text_encoders\\\\qwen3vl_8b_int8_convrot.safetensors', vae: 'vae\\\\qwen_image_2.1_vae_bf16.safetensors' },
]

function detectModelFiles(config = {}) {
  const roots = [config.modelPath, process.env.QWEN_IMAGE_MODEL_HOME, ...MODEL_LAYOUTS.map(item => item.root)].filter(Boolean)
  for (const root of [...new Set(roots.map(value => resolve(value)))]) {
    const layout = MODEL_LAYOUTS.find(item => resolve(item.root).toLowerCase() === root.toLowerCase())
    const files = layout
      ? [layout.diffusion, layout.encoder, layout.vae]
      : [
          'diffusion_models/qwen-image-2.1-UC-Q4_K_M.gguf',
          'text_encoders/qwen3vl_8b_int8_convrot.safetensors',
          'vae/qwen_image_2.1_vae_bf16.safetensors',
        ]
    if (files.every(file => existsSync(join(root, file)))) return root
    const flatFiles = ['qwen-image-2.1-UC-Q4_K_M.gguf', 'qwen3vl_8b_int8_convrot.safetensors', 'qwen_image_2.1_vae_bf16.safetensors']
    if (flatFiles.every(file => existsSync(join(root, file)))) return root
  }
  return null
}

function detectComfyUI(config = {}) {
  const home = homedir()
  const candidates = [
    config.comfyuiPath,
    process.env.COMFYUI_HOME,
    process.env.COMFYUI_PATH,
    'D:\\\\ComfyUI',
    'C:\\\\ComfyUI',
    join(home, 'ComfyUI'),
    join(home, 'AI', 'ComfyUI'),
    join(home, 'Documents', 'ComfyUI'),
    join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'DSH', 'ComfyUI'),
  ].filter(Boolean)
  for (const candidate of [...new Set(candidates.map(value => resolve(value)))]) {
    if (!existsSync(join(candidate, 'main.py'))) continue
    const python = [
      join(candidate, '.venv', 'Scripts', 'python.exe'),
      join(candidate, 'venv', 'Scripts', 'python.exe'),
      join(candidate, 'venv', 'bin', 'python'),
    ].find(existsSync) ?? 'python'
    const port = new URL(config.baseUrl ?? 'http://127.0.0.1:8188').port || '8188'
    const listen = new URL(config.baseUrl ?? 'http://127.0.0.1:8188').hostname
    const command = process.platform === 'win32'
      ? `"${python}" "${join(candidate, 'main.py')}" --listen ${listen} --port ${port}`
      : `"${python}" "${join(candidate, 'main.py')}" --listen ${listen} --port ${port}`
    return { path: candidate, python, launchCommand: command }
  }
  return null
}

function effectiveConfig(config = {}) {
  const merged = {
    protocol: 'comfyui', baseUrl: 'http://127.0.0.1:8188', model: 'qwen-image', apiKey: '',
    outputDir: '.dsh-generated/qwen-image', timeoutMs: 600000, autoStart: true,
    launchCommand: '', launchCwd: '', readyTimeoutMs: 300000, modelPath: '', comfyWorkflow: '{}',
    promptNodeId: '', promptInput: 'text', negativeNodeId: '', negativeInput: 'text',
    widthNodeId: '', widthInput: 'width', heightNodeId: '', heightInput: 'height',
    ...config,
  }
  if (merged.protocol === 'comfyui' && !merged.launchCommand) {
    const detected = detectComfyUI(merged)
    if (detected) {
      merged.comfyuiPath = detected.path
      merged.launchCommand = detected.launchCommand
      merged.launchCwd = detected.path
    }
  }
  return merged
}

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const PROBE_TIMEOUT_MS = 3000
const MIME_EXTENSIONS = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/webp', '.webp'],
])

// One in-flight auto-start per base URL, shared by concurrent tool calls.
const startupByTarget = new Map()

function cleanBaseUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('baseUrl must use HTTP or HTTPS')
  return url.toString().replace(/\/$/, '')
}

function probeUrl(config) {
  const root = cleanBaseUrl(config.baseUrl)
  return config.protocol === 'comfyui' ? `${root}/system_stats` : `${root}/models`
}

async function isReady(config) {
  try {
    const response = await fetch(probeUrl(config), { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    // Any HTTP answer means something is listening; 4xx/5xx still proves the service is up.
    await response.arrayBuffer().catch(() => {})
    return true
  } catch {
    return false
  }
}

function wait(ms, signal) {
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(signal?.reason ?? new Error('Operation aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolvePromise()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function launch(config) {
  const command = config.launchCommand.trim()
  if (!command) {
    const detected = detectComfyUI(config)
    if (!detected) throw new Error('No local ComfyUI installation was found. Call qwen_image_setup with action "status" to inspect, or action "install" to install ComfyUI and the GGUF node. Add Qwen model weights to the detected model path before generating.')
    config.launchCommand = detected.launchCommand
    config.launchCwd = detected.path
  }
  const child = spawn(command, {
    shell: true,
    cwd: config.launchCwd || undefined,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.on('error', () => {})
  child.unref()
}

async function startAndWait(config, signal) {
  launch(config)
  const deadline = Date.now() + config.readyTimeoutMs
  while (Date.now() < deadline) {
    await wait(1500, signal)
    if (await isReady(config)) return
  }
  throw new Error(`The image service at ${cleanBaseUrl(config.baseUrl)} did not become ready within ${config.readyTimeoutMs} ms after running launchCommand`)
}

async function ensureReady(config, signal) {
  if (!config.autoStart) return
  if (await isReady(config)) return
  const key = cleanBaseUrl(config.baseUrl) + '|' + config.protocol
  const existing = startupByTarget.get(key)
  if (existing) return existing
  const pending = startAndWait(config, signal).finally(() => startupByTarget.delete(key))
  startupByTarget.set(key, pending)
  return pending
}

function mimeFromBytes(bytes, header = '') {
  if (header.startsWith('image/')) {
    const mime = header.split(';')[0].trim().toLowerCase()
    if (MIME_EXTENSIONS.has(mime)) return mime
  }
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg'
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  throw new Error('The image service returned an unsupported image format (PNG, JPEG, or WebP required)')
}

async function fetchChecked(url, options, signal) {
  const response = await fetch(url, { ...options, signal })
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 1200)
    throw new Error(`Image service returned HTTP ${response.status}: ${detail}`)
  }
  return response
}

async function openAiImage(config, prompt, size, signal) {
  const response = await fetchChecked(`${cleanBaseUrl(config.baseUrl)}/images/generations`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: config.model,
      prompt,
      size,
      n: 1,
      response_format: 'b64_json',
    }),
  }, signal)
  const payload = await response.json()
  const item = payload?.data?.[0]
  if (typeof item?.b64_json === 'string') {
    if (item.b64_json.length > Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 8) throw new Error('Generated image exceeds 30 MiB')
    return Buffer.from(item.b64_json, 'base64')
  }
  if (typeof item?.url === 'string') {
    const imageResponse = await fetchChecked(item.url, {}, signal)
    const bytes = Buffer.from(await imageResponse.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds 30 MiB')
    return bytes
  }
  throw new Error('Image API response has neither data[0].b64_json nor data[0].url')
}

function setWorkflowInput(workflow, nodeId, inputName, value, label) {
  if (!nodeId) return
  const node = workflow[nodeId]
  if (!node || !node.inputs || !(inputName in node.inputs)) {
    throw new Error(`${label} node ${nodeId} must exist in comfyWorkflow and contain inputs.${inputName}`)
  }
  node.inputs[inputName] = value
}

async function comfyImage(config, prompt, negativePrompt, width, height, signal) {
  let workflow
  try {
    workflow = JSON.parse(config.comfyWorkflow)
  } catch {
    throw new Error('comfyWorkflow must be a valid ComfyUI API-format JSON workflow')
  }
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) throw new Error('comfyWorkflow must be a JSON object')
  if (!config.promptNodeId) throw new Error('Set promptNodeId to the prompt node in your ComfyUI API workflow')
  setWorkflowInput(workflow, config.promptNodeId, config.promptInput || 'text', prompt, 'Prompt')
  if (negativePrompt) setWorkflowInput(workflow, config.negativeNodeId, config.negativeInput || 'text', negativePrompt, 'Negative prompt')
  setWorkflowInput(workflow, config.widthNodeId, config.widthInput || 'width', width, 'Width')
  setWorkflowInput(workflow, config.heightNodeId, config.heightInput || 'height', height, 'Height')

  const root = cleanBaseUrl(config.baseUrl)
  const submitted = await fetchChecked(`${root}/prompt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: workflow }),
  }, signal)
  const { prompt_id: promptId } = await submitted.json()
  if (typeof promptId !== 'string' || !promptId) throw new Error('ComfyUI did not return prompt_id')

  const deadline = Date.now() + config.timeoutMs
  while (Date.now() < deadline) {
    await wait(1200, signal)
    const historyResponse = await fetchChecked(`${root}/history/${encodeURIComponent(promptId)}`, {}, signal)
    const history = await historyResponse.json()
    const result = history?.[promptId]
    const image = result?.outputs && Object.values(result.outputs).flatMap(output => output.images ?? [])[0]
    if (image) {
      const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder ?? '', type: image.type ?? 'output' })
      const imageResponse = await fetchChecked(`${root}/view?${query}`, {}, signal)
      const bytes = Buffer.from(await imageResponse.arrayBuffer())
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image exceeds 30 MiB')
      return { bytes, mime: imageResponse.headers.get('content-type') ?? '' }
    }
    if (result?.status?.completed && !image) throw new Error('ComfyUI completed without producing an image')
  }
  throw new Error(`ComfyUI job ${promptId} exceeded timeoutMs (${config.timeoutMs})`)
}

async function generate(config, args, exec, workingDirectory) {
  config = effectiveConfig(config)
  if (typeof args.prompt !== 'string' || !args.prompt.trim()) throw new Error('prompt must not be empty')
  const width = args.width ?? 1024
  const height = args.height ?? 1024
  for (const [label, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 256 || value > 2048 || value % 64 !== 0) {
      throw new Error(`${label} must be an integer from 256 to 2048 divisible by 64`)
    }
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 900000) {
    throw new Error('timeoutMs must be between 1000 and 900000')
  }

  const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(config.timeoutMs)])
  await ensureReady(config, signal)
  const prompt = args.negative_prompt ? `${args.prompt.trim()}\n\nNegative prompt: ${args.negative_prompt.trim()}` : args.prompt.trim()
  const generated = config.protocol === 'comfyui'
    ? await comfyImage(config, args.prompt.trim(), args.negative_prompt ?? '', width, height, signal)
    : { bytes: await openAiImage(config, prompt, `${width}x${height}`, signal), mime: '' }
  if (generated.bytes.length === 0 || generated.bytes.length > MAX_IMAGE_BYTES) throw new Error('Generated image size must be between 1 byte and 30 MiB')
  const mimeType = mimeFromBytes(generated.bytes, generated.mime)
  const extension = MIME_EXTENSIONS.get(mimeType)
  const cwd = workingDirectory.get(exec.agent.session)
  const outputDirectory = isAbsolute(config.outputDir) ? config.outputDir : resolve(cwd, config.outputDir)
  await mkdir(outputDirectory, { recursive: true })
  const filename = `qwen-${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}${extension}`
  const outputPath = join(outputDirectory, basename(filename))
  await writeFile(outputPath, generated.bytes, { flag: 'wx' })
  return { path: outputPath, mimeType, bytes: generated.bytes.length, prompt: args.prompt.trim(), width, height }
}

export function apply(ctx, config) {
  const runtimeConfig = effectiveConfig(config)
  const discoveredComfy = detectComfyUI(runtimeConfig)
  const discoveredModels = detectModelFiles(runtimeConfig)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'generate_qwen_image',
    description: 'Generate one image with the locally configured Qwen Image service and save it in the current session working directory. Use for image creation requests. Provide a detailed visual prompt; width and height must be multiples of 64 between 256 and 2048. When the local service is not running, it is started automatically.',
    parameters: {
      prompt: { type: 'string', required: true, description: 'Detailed image description, including subject, composition, style, lighting, and any text to render.' },
      negative_prompt: { type: 'string', description: 'Optional elements or artifacts to avoid.' },
      width: { type: 'integer', description: 'Image width, 256–2048 and divisible by 64. Defaults to 1024.' },
      height: { type: 'integer', description: 'Image height, 256–2048 and divisible by 64. Defaults to 1024.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          mimeType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          prompt: { type: 'string', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Generated image saved: ${value.path}\nFormat: ${value.mimeType}; ${value.bytes} bytes; requested size ${value.width}x${value.height}.\nPrompt: ${value.prompt}`,
      }],
    },
    async execute(args, exec) {
      if (!exec.agent) throw new Error('generate_qwen_image requires a calling session')
      return generate(runtimeConfig, args, exec, ctx.workingDirectory)
    },
  })))

  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'qwen_image_setup',
    description: 'Inspect local ComfyUI and Qwen image model files after plugin installation. If ComfyUI is missing, the user can explicitly choose to install the ComfyUI runtime and GGUF custom node. This does not download large Qwen model weights.',
    parameters: {
      action: { type: 'string', required: true, description: 'Use status to inspect local installations, or install to start the optional ComfyUI installer.' },
      cuda: { type: 'boolean', description: 'For action install, use CUDA PyTorch when an NVIDIA GPU and compatible driver are installed; defaults to CPU PyTorch.' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          comfyuiPath: { type: 'string', required: true },
          modelPath: { type: 'string', required: true },
          message: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.message }],
    },
    async execute(args, exec) {
      if (!['status', 'install'].includes(args.action)) throw new Error('action must be status or install')
      const comfy = detectComfyUI(runtimeConfig)
      const models = detectModelFiles(runtimeConfig)
      if (args.action === 'status') {
        const status = comfy ? (models ? 'ready' : 'model-files-missing') : 'comfyui-missing'
        const message = comfy
          ? `ComfyUI found at ${comfy.path}. ${models ? `Qwen model files found at ${models}.` : 'No supported Qwen Image model set was detected in the common model folders. Place model files in ComfyUI models directories or set modelPath.'} ${await isReady(runtimeConfig) ? 'The service is responding.' : runtimeConfig.autoStart ? 'It will be started automatically on first image-generation call.' : 'autoStart is disabled.'}`
          : `No ComfyUI installation was found in configured/common locations. Optional install is available: call qwen_image_setup with action "install". The installer sets up ComfyUI and ComfyUI-GGUF; Qwen model weights are separate and are not downloaded automatically.`
        return { status, comfyuiPath: comfy?.path ?? '', modelPath: models ?? '', message }
      }
      if (process.platform !== 'win32') throw new Error('The bundled installer currently supports Windows. Install ComfyUI manually and set COMFYUI_HOME.')
      if (!existsSync(INSTALL_SCRIPT)) throw new Error(`Installer script is missing: ${INSTALL_SCRIPT}`)
      if (comfy) throw new Error(`ComfyUI is already installed at ${comfy.path}; qwen_image_setup status can inspect it.`)
      const destination = join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'DSH', 'ComfyUI')
      const child = spawn('powershell.exe', [
        '-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', INSTALL_SCRIPT,
        '-Destination', destination,
        ...(models ? ['-ModelPath', models] : []),
        ...(args.cuda ? ['-Cuda'] : []),
      ], { detached: true, stdio: 'ignore', windowsHide: false })
      child.on('error', () => {})
      child.unref()
      return {
        status: 'install-started', comfyuiPath: destination, modelPath: models ?? '',
        message: `ComfyUI installation started in a PowerShell window at ${destination}. Once it finishes, place Qwen model files in the ComfyUI model folders or set modelPath, then call qwen_image_setup with action "status".`,
      }
    },
  })))
}

export const __internals = { isReady, ensureReady, launch, detectComfyUI, detectModelFiles, effectiveConfig }
