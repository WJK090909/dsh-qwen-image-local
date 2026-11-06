# DSH Local Qwen Image

在 DSH 内提供 `generate_qwen_image` 工具，用于调用本机 Qwen Image 服务并把生成图片保存到当前会话工作目录。

## 支持接口

- `openai`：OpenAI Images API 兼容服务。默认请求 `POST http://127.0.0.1:8000/v1/images/generations`，请求中包含 `model`、`prompt`、`size` 和 `n: 1`。服务应返回 `data[0].b64_json` 或 `data[0].url`。
- `comfyui`：ComfyUI HTTP API。提供 ComfyUI 的 API 格式 workflow JSON，并配置正向提示词节点 ID；插件提交 `/prompt`、轮询 `/history/{prompt_id}`，再从 `/view` 下载首张图片。

接口由 `cordis.patch.yml` 中插件行的配置控制。`outputDir` 默认是会话工作目录下的 `.dsh-generated/qwen-image`。

## 调用时自动拉起服务

工具执行前会先探测 `baseUrl`（ComfyUI 探 `/system_stats`，OpenAI 兼容服务探 `/models`）。探测失败且 `autoStart` 为真时，插件执行 `launchCommand`，然后每 1.5 秒重探测一次，直到就绪或超过 `readyTimeoutMs`。服务本来就在跑时不会重复启动；并发调用共享同一个启动流程，不会拉起多份。

```yaml
autoStart: true
launchCommand: '"D:\ComfyUI\venv\Scripts\python.exe" "D:\ComfyUI\main.py" --listen 127.0.0.1 --port 8188'
launchCwd: 'D:\ComfyUI'
readyTimeoutMs: 300000
```

- `launchCommand` 用 shell 执行，可以写带引号的完整路径，也可以用 `&&` 串联多条命令。
- 进程以独立进程组启动（`detached`）且不接管输出，插件退出后服务继续运行，下次调用直接复用。
- `autoStart: false` 时只探测不启动，服务没起就报出连接信息。
- `launchCommand` 为空时会重新扫描常见 ComfyUI 路径；仍未发现时提示运行 `qwen_image_setup` 安装/检查。

## 安装

在 DSH 插件管理器中添加 `dsh-qwen-image-local`（本地目录或插件包均可），启用后插件启动阶段就会扫描本机 ComfyUI 和已知 Qwen 模型目录。若没有检测到 ComfyUI，聊天中可调用 `qwen_image_setup` 查看安装选项；安装程序不会在插件安装时静默改动系统环境。

### OpenAI Images 兼容服务

按你的本地推理服务实际监听端口调整配置：

```yaml
protocol: openai
baseUrl: http://127.0.0.1:8000/v1
model: qwen-image
apiKey: ''
outputDir: .dsh-generated/qwen-image
timeoutMs: 240000
```

### ComfyUI

在 ComfyUI 中导出 **API 格式** workflow JSON。把它放入 `comfyWorkflow` 字符串，填写正向提示词节点 ID。`promptInput` 默认是 `text`；按节点的 inputs 键名调整。负向提示词节点可选。需要让工具的宽高参数驱动 latent 节点时，另外设置 `widthNodeId` / `heightNodeId` 以及对应的 input 名：

```yaml
protocol: comfyui
baseUrl: http://127.0.0.1:8188
outputDir: .dsh-generated/qwen-image
timeoutMs: 240000
promptNodeId: '6'
promptInput: text
negativeNodeId: '7'
negativeInput: text
widthNodeId: '5'
widthInput: width
heightNodeId: '5'
heightInput: height
comfyWorkflow: '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"","clip":["4",1]}},"7":{"class_type":"CLIPTextEncode","inputs":{"text":"","clip":["4",1]}}}'
```

上例只展示了文本节点字段，实际 workflow 需要包含完整的模型加载、采样、解码和保存节点。 ComfyUI API workflow 中应保留保存图片节点；插件会从执行历史的 outputs 中取第一张图片。

## 安装后首次检查

插件激活时会自动扫描已配置路径、`COMFYUI_HOME` / `COMFYUI_PATH`、`D:\\ComfyUI`、`C:\\ComfyUI`、用户目录下的 ComfyUI，以及 DSH 默认安装目录；同时检查已知 Qwen-Image 2.1 UC 权重目录。发现 ComfyUI 后自动生成启动命令，首次调用绘图工具时按需启动并等待服务就绪。

插件另外注册 `qwen_image_setup` 工具：

- `action: "status"` 检查 ComfyUI 和 Qwen 权重检测结果；缺少 ComfyUI 时明确显示安装选项。
- `action: "install"` 在 Windows 打开 PowerShell 安装窗口，安装 ComfyUI、PyTorch 和 ComfyUI-GGUF；如果检测到常见 Qwen-Image 2.1 UC 文件夹，也会为 ComfyUI 写入 `extra_model_paths.yaml`。
- 安装动作由用户明确调用才开始。大体积模型文件不会自动下载；没有模型文件时，status 会提示放置位置。

安装 ComfyUI 需要 Git、Python 3.11 和网络连接。安装器默认配置 CPU PyTorch；有 NVIDIA GPU 且驱动支持 CUDA 12.8 时，可用 `cuda: true` 选择 CUDA wheel。

## 使用

安装并启用插件后，在 DSH 对话中要求绘图即可使用 `generate_qwen_image`。如果本地组件尚未配置，可先让模型调用 `qwen_image_setup` 并选择 `status`；不存在 ComfyUI 时选择 `install`。模型检测完成后，图片生成会自动拉起 ComfyUI，无需另外手动启动。

默认工作流针对 Qwen-Image 2.1 UC GGUF，文件名为：

- `qwen-image-2.1-UC-Q4_K_M.gguf`
- `qwen3vl_8b_int8_convrot.safetensors`
- `qwen_image_2.1_vae_bf16.safetensors`

如使用其他 Qwen 变体，请修改插件配置中的 `comfyWorkflow`、节点 ID 和对应权重名。图片保存到当前会话工作目录下的 `.dsh-generated/qwen-image`。

## 开发验证

```powershell
node --check index.js
node --test tests/*.test.js
```
