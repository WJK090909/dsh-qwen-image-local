param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [string]$ModelPath,
    [switch]$Cuda
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Write-Status([string]$Message) {
    Write-Host "[DSH Qwen setup] $Message"
}

if (Test-Path (Join-Path $Destination 'main.py')) {
    Write-Status "ComfyUI already exists at $Destination"
    exit 0
}
if (Test-Path $Destination) {
    throw "Destination exists but is not a ComfyUI checkout: $Destination"
}

$git = Get-Command git -ErrorAction SilentlyContinue
if (-not $git) { throw 'Git is required. Install Git for Windows and run qwen_image_setup action status again.' }
$py = Get-Command py -ErrorAction SilentlyContinue
if (-not $py) { throw 'Python launcher (py.exe) is required. Install Python 3.11 or 3.12, then retry.' }

$parent = Split-Path -Parent $Destination
New-Item -ItemType Directory -Force -Path $parent | Out-Null
Write-Status "Cloning ComfyUI into $Destination"
& $git.Source clone --depth 1 https://github.com/comfyanonymous/ComfyUI.git $Destination
if ($LASTEXITCODE -ne 0) { throw "ComfyUI clone failed with exit code $LASTEXITCODE" }

Write-Status 'Creating Python 3.11 virtual environment'
& $py.Source '-3.11' -m venv (Join-Path $Destination 'venv')
if ($LASTEXITCODE -ne 0) { throw 'Could not create a Python 3.11 virtual environment. Install Python 3.11 and retry.' }
$python = Join-Path $Destination 'venv\Scripts\python.exe'

if ($Cuda) {
    Write-Status 'Installing CUDA 12.8 PyTorch wheels'
    & $python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }
    & $python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu128
} else {
    Write-Status 'Installing CPU PyTorch wheels'
    & $python -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw 'pip upgrade failed' }
    & $python -m pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cpu
}
if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed' }

Write-Status 'Installing ComfyUI Python requirements'
& $python -m pip install -r (Join-Path $Destination 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI requirements installation failed' }

$customNodes = Join-Path $Destination 'custom_nodes'
New-Item -ItemType Directory -Force -Path $customNodes | Out-Null
$ggufPath = Join-Path $customNodes 'ComfyUI-GGUF'
Write-Status 'Installing ComfyUI-GGUF custom node'
& $git.Source clone --depth 1 https://github.com/city96/ComfyUI-GGUF.git $ggufPath
if ($LASTEXITCODE -ne 0) { throw 'ComfyUI-GGUF clone failed' }
$ggufRequirements = Join-Path $ggufPath 'requirements.txt'
if (Test-Path $ggufRequirements) {
    & $python -m pip install -r $ggufRequirements
    if ($LASTEXITCODE -ne 0) { throw 'ComfyUI-GGUF requirements installation failed' }
}

if ($ModelPath -and (Test-Path $ModelPath)) {
    $normalizedModelPath = $ModelPath.Replace('\', '/')
    $modelConfig = @"
qwen_image_2_1_uc:
  base_path: "$normalizedModelPath"
  unet: diffusion_models
  clip: text_encoders
  vae: vae
"@
    Set-Content -Path (Join-Path $Destination 'extra_model_paths.yaml') -Value $modelConfig -Encoding utf8
    Write-Status "Configured external Qwen model files from $ModelPath"
}

Write-Status 'Installation complete. Qwen model weights are not bundled.'
Write-Status "Start command: `"$python`" `"$(Join-Path $Destination 'main.py')`" --listen 127.0.0.1 --port 8188"
Write-Status 'Put diffusion model, text encoder and VAE files under ComfyUI model folders, or configure extra_model_paths.yaml.'
