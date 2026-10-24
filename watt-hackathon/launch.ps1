param([int]$Port = 8501)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$pythonExecutable = Join-Path $projectDirectory '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $pythonExecutable)) {
    throw 'Create .venv and install requirements.txt first; see README.md.'
}
Push-Location $projectDirectory
try {
    & $pythonExecutable -m streamlit run app.py --server.address 127.0.0.1 --server.port $Port --server.headless true
} finally {
    Pop-Location
}
