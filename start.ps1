param([switch]$SetupOnly)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Tools = Join-Path $Root "tools"
$YtDlp = Join-Path $Tools "yt-dlp.exe"
$Ffmpeg = Join-Path $Tools "ffmpeg.exe"
$Ffprobe = Join-Path $Tools "ffprobe.exe"
$Deno = Join-Path $Tools "deno.exe"

New-Item -ItemType Directory -Force -Path $Tools | Out-Null

function Get-RemoteFile([string]$Uri, [string]$Destination) {
    $Curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($Curl) {
        & $Curl.Source -L --fail --retry 3 --progress-bar -o $Destination $Uri
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Uri" }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Uri -OutFile $Destination
    }
}

if (-not (Test-Path $YtDlp)) {
    Write-Host "[1/3] Preparing yt-dlp..."
    Get-RemoteFile "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe" $YtDlp
}

if (-not (Test-Path $Ffmpeg) -or -not (Test-Path $Ffprobe)) {
    Write-Host "[2/3] Preparing FFmpeg (this takes a little while on first run)..."
    $Archive = Join-Path $Tools "ffmpeg.zip"
    $Extracted = Join-Path $Tools "ffmpeg-extracted"
    Get-RemoteFile "https://github.com/yt-dlp/FFmpeg-Builds/releases/latest/download/ffmpeg-master-latest-win64-gpl.zip" $Archive
    Expand-Archive -LiteralPath $Archive -DestinationPath $Extracted -Force
    $FfmpegSource = Get-ChildItem -LiteralPath $Extracted -Recurse -Filter "ffmpeg.exe" | Select-Object -First 1
    $FfprobeSource = Get-ChildItem -LiteralPath $Extracted -Recurse -Filter "ffprobe.exe" | Select-Object -First 1
    if (-not $FfmpegSource -or -not $FfprobeSource) { throw "Could not extract FFmpeg." }
    Copy-Item -LiteralPath $FfmpegSource.FullName -Destination $Ffmpeg -Force
    Copy-Item -LiteralPath $FfprobeSource.FullName -Destination $Ffprobe -Force
    Remove-Item -LiteralPath $Archive -Force
    Remove-Item -LiteralPath $Extracted -Recurse -Force
}

if (-not (Test-Path $Deno)) {
    Write-Host "[3/3] Preparing the YouTube JavaScript runtime..."
    $DenoArchive = Join-Path $Tools "deno.zip"
    Get-RemoteFile "https://github.com/denoland/deno/releases/latest/download/deno-x86_64-pc-windows-msvc.zip" $DenoArchive
    Expand-Archive -LiteralPath $DenoArchive -DestinationPath $Tools -Force
    Remove-Item -LiteralPath $DenoArchive -Force
    if (-not (Test-Path $Deno)) { throw "Could not extract Deno." }
}

if ($SetupOnly) {
    Write-Host "The conversion engines are ready."
    exit 0
}

$Python = $null
$CodexRuntimeRoot = Join-Path $env:USERPROFILE ".cache\codex-runtimes"
if (Test-Path $CodexRuntimeRoot) {
    $BundledPython = Get-ChildItem -LiteralPath $CodexRuntimeRoot -Recurse -Filter "python.exe" -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -like "*\dependencies\python\python.exe" } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 1
    if ($BundledPython) { $Python = $BundledPython }
}
if (-not $Python) { $Python = Get-Command py -ErrorAction SilentlyContinue }
if (-not $Python) { $Python = Get-Command python -ErrorAction SilentlyContinue }
if (-not $Python) {
    Write-Host "Python 3 is required. Install it from https://www.python.org/downloads/." -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

Write-Host "Starting the tool. Press Ctrl+C in this window to stop it."
$PythonPath = if ($Python.Source) { $Python.Source } else { $Python.FullName }
& $PythonPath (Join-Path $Root "app.py")
