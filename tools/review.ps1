<#
.SYNOPSIS
  Opens a fresh VS Code with a given build of Video Preview Enhanced and a folder of test videos.
.DESCRIPTION
  review.cmd [target] [flags]    (docs/REVIEW.md)
  target   a git ref of the main repo (branch, tag, commit; default main) or a path to a .vsix
  -Dirty      build from the worktree that has the branch checked out, including uncommitted changes
  -Dev        no packaging: --extensionDevelopmentPath (faster; title says Extension Development Host)
  -Code <v>   another portable VS Code version (fetched by test/vscode/get_code.js); default: pinned
  -Installed  use the normally installed `code` instead of the portable build
  -Media <d>  open this folder instead of the generated review folder
  -Checklist <file.md>  copied into the folder as REVIEW.md and opened
  -DryRun     print every command and path, launch nothing, create nothing
  -NoWait     return as soon as VS Code is started (nothing is cleaned up)
  -Keep       keep the temp profile, worktree and folder afterwards
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)][string]$Target = 'main',
  [switch]$Dirty, [switch]$Dev, [string]$Code = '', [switch]$Installed,
  [string]$Media = '', [string]$Checklist = '',
  [switch]$DryRun, [switch]$NoWait, [switch]$Keep, [switch]$NoFfmpeg, [switch]$NoFfmpegOnPath
)
$ErrorActionPreference = 'Stop'

function Q([string]$s) { '"' + $s + '"' }
function Say([string]$s) { Write-Host $s }
function Cmd([string]$s) { Write-Host ("CMD: " + $s) }
function Fail([string]$s) { Write-Host ("review: ERROR: " + $s) -ForegroundColor Red; exit 1 }
function Note([string]$s) { Write-Host ("review: " + $s) -ForegroundColor Yellow }

# ---- where things are ----
$ToolRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gitCommon = (& git -C $ToolRoot rev-parse --path-format=absolute --git-common-dir) 2>$null
if ($LASTEXITCODE -ne 0 -or -not $gitCommon) { Fail "$ToolRoot is not a git checkout" }
$Main = Split-Path -Parent ($gitCommon.Trim() -replace '/', '\')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Work = Join-Path $env:TEMP "vpe-review-$Stamp"
$Src = Join-Path $Work 'src'            # temp worktree (when needed)
$UserData = Join-Path $Work 'user-data'
$ExtDir = Join-Path $Work 'extensions'
$Videos = Join-Path $Work 'videos'
$madeWorktree = $false
$isVsix = $Target -match '\.vsix$'

# ---- 1. target ----
$vsix = ''; $buildDir = ''; $sha = ''; $short = ''; $version = ''; $describe = ''
if ($isVsix) {
  if (-not (Test-Path -LiteralPath $Target -PathType Leaf)) { Fail "no such .vsix: $Target" }
  if ($Dev) { Fail "-Dev needs source code (a git ref), not a .vsix" }
  $vsix = (Resolve-Path -LiteralPath $Target).Path
  $short = 'vsix'; $sha = '(prebuilt package)'; $describe = "package $vsix"
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($vsix)
    $e = $zip.GetEntry('extension/package.json')
    $rd = New-Object IO.StreamReader($e.Open()); $version = ($rd.ReadToEnd() | ConvertFrom-Json).version; $rd.Close(); $zip.Dispose()
  } catch { $version = '(unknown)' }
} else {
  $sha = (& git -C $Main rev-parse --verify --quiet "$Target^{commit}") 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $sha) { Fail "'$Target' is neither a .vsix file nor a git ref in $Main" }
  $sha = $sha.Trim()
  $short = (& git -C $Main rev-parse --short=7 $sha).Trim()
  $describe = "$Target @ $short"
  # a worktree that has this branch checked out?
  $wtPath = ''
  $cur = @{}
  foreach ($line in ((& git -C $Main worktree list --porcelain) + '')) {
    if ($line -eq '') {
      if ($cur.path -and $cur.branch -and ($cur.branch -eq "refs/heads/$Target" -or $cur.branch -eq $Target)) { $wtPath = $cur.path }
      $cur = @{}
    } elseif ($line -match '^worktree (.+)$') { $cur.path = ($Matches[1] -replace '/', '\') }
    elseif ($line -match '^branch (.+)$') { $cur.branch = $Matches[1] }
  }
  $buildDir = $Src
  if ($wtPath) {
    $dirtyCount = @(& git -C $wtPath status --porcelain).Count
    if ($Dirty) {
      $buildDir = $wtPath; $describe += " (working copy of $wtPath, $dirtyCount uncommitted change(s))"
    } elseif ($dirtyCount -gt 0) {
      Note "$wtPath has $dirtyCount uncommitted change(s); building the COMMITTED state ($short). Use -Dirty to include them."
    }
  } elseif ($Dirty) { Note "-Dirty: no worktree has '$Target' checked out; using the committed state." }
  if ($buildDir -ne $Src) {
    $sha = (& git -C $buildDir rev-parse HEAD).Trim(); $short = (& git -C $buildDir rev-parse --short=7 HEAD).Trim() + '-dirty'
    $version = (Get-Content -Raw -LiteralPath (Join-Path $buildDir 'package.json') | ConvertFrom-Json).version
  } else {
    $version = ((& git -C $Main show "${sha}:package.json") -join "`n" | ConvertFrom-Json).version
  }
  $vsix = Join-Path $Work "vpe-$short.vsix"
}

# ---- 3a. VS Code ----
$getCode = Join-Path $Main 'test\vscode\get_code.js'
if (-not (Test-Path $getCode)) { $getCode = Join-Path $ToolRoot 'test\vscode\get_code.js' }
$codeBase = Join-Path (Split-Path -Parent $getCode) '.code'
$codeExe = ''; $codeCli = ''; $codeVersion = ''; $fetch = $false
if ($Installed) {
  $c = Get-Command code.cmd -ErrorAction SilentlyContinue
  if (-not $c) { Fail "-Installed: 'code' is not on PATH" }
  $codeCli = $c.Source; $codeExe = Join-Path (Split-Path -Parent (Split-Path -Parent $codeCli)) 'Code.exe'
  if (-not (Test-Path $codeExe)) { Fail "Code.exe not found next to $codeCli" }
  $codeVersion = (((& $codeCli --version) | Select-Object -First 1) + ' (installed)')
} else {
  $codeVersion = $Code
  if (-not $codeVersion) {
    $m = Select-String -Path $getCode -Pattern "PINNED\s*=\s*'([^']+)'" | Select-Object -First 1
    if (-not $m) { Fail "cannot read PINNED from $getCode" }
    $codeVersion = $m.Matches[0].Groups[1].Value
  }
  $codeDir = Join-Path $codeBase $codeVersion
  $codeExe = Join-Path $codeDir 'Code.exe'; $codeCli = Join-Path $codeDir 'bin\code.cmd'
  if (-not (Test-Path $codeExe)) { $fetch = $true }
}

# ---- 4. review folder: group, source (relative to test/media), optional new name ----
$plan = @(
  @('codecs', 'h264_aac_anim_1080p.mp4'), @('codecs', 'hevc_10_2160p.mp4'), @('codecs', 'av1_10_1080p.mp4'),
  @('codecs', 'vp9_opus_anim_1080p.webm'), @('codecs', 'prores_proxy_1080p.mov'), @('codecs', 'dnxhr_lb_1080p.mov'),
  @('codecs', 'mpeg2_1080p.mpg'),
  @('hdr', 'hevc_10_pq_2160p.mp4'), @('hdr', 'hevc_10_hlg_2160p.mp4'),
  @('containers', 'containers\h264_aac.avi'), @('containers', 'containers\h264_aac.flv'),
  @('containers', 'containers\h264_aac.m2ts'), @('containers', 'containers\h264_aac.mkv'),
  @('containers', 'containers\h264_aac.mov'), @('containers', 'containers\vp8_vorbis.webm'),
  @('tracks-and-subtitles', 'cases\tracks_multi.mkv'),
  @('tracks-and-subtitles', 'tracks\tracks_vtt.webm'), @('tracks-and-subtitles', 'tracks\opengop_hevc.mkv'),
  @('long-and-odd', 'cases\long_20s.mp4'), @('long-and-odd', 'cases\rotated.mp4'), @('long-and-odd', 'cases\h264_60fps.mkv'),
  @('long-and-odd', 'cases\ntsc_2997.mkv'), @('long-and-odd', 'cases\truehd_51side.mkv'),
  @('long-and-odd', 'cases\damaged_h264.mkv'), @('long-and-odd', 'cases\trunc.mkv')
)
function Find-Media([string]$rel) {
  foreach ($root in @($ToolRoot, $Main)) { $p = Join-Path $root ('test\media\' + $rel); if (Test-Path -LiteralPath $p) { return $p } }
  return ''
}
$items = @(); $missing = @()
foreach ($e in $plan) {
  $p = Find-Media $e[1]
  $name = Split-Path -Leaf $e[1]
  if ($p) { $items += , @($e[0], $p, $name) } else { $missing += $e[1] }
}
$sidecarSrc = Find-Media 'cases\long_20s.mp4'
$srt = ''
foreach ($root in @($ToolRoot, $Main)) { $c = Join-Path $root 'test\subtitles\fixtures\overlap.srt'; if (Test-Path $c) { $srt = $c; break } }
$openFolder = if ($Media) { $Media } else { $Videos }
if ($Media -and -not (Test-Path -LiteralPath $Media -PathType Container)) { Fail "-Media folder not found: $Media" }
if ($Checklist -and -not (Test-Path -LiteralPath $Checklist -PathType Leaf)) { Fail "-Checklist file not found: $Checklist" }
$reviewMd = Join-Path $openFolder 'REVIEW.md'

# ---- summary ----
$modeText = if ($Dev) { 'development host (--extensionDevelopmentPath, no package)' } else { 'installed VSIX' }
Say ''
Say ('Review launcher' + $(if ($DryRun) { ' (DRY RUN: nothing is created or launched)' } else { '' }))
Say "  target       : $describe"
Say "  commit       : $sha"
Say "  version      : $version (package.json)"
Say "  mode         : $modeText"
Say "  VS Code      : $codeVersion  [$codeExe]"
Say "  profile      : $Work  (user-data, extensions)"
Say ("  folder       : $openFolder" + $(if ($Media) { '  (your own folder)' } else { '' }))
if ($missing.Count) { Say ("  missing media: " + ($missing -join ', ') + "  (made by test/media/make_media.js, test/tracks/make_media.js)") }
Say ''

# ---- helpers ----
function Clear-VsEnv {
  # Started from a VS Code terminal these would hijack the new instance.
  foreach ($n in @(Get-ChildItem env: | Where-Object { $_.Name -like 'VSCODE_*' -or $_.Name -eq 'ELECTRON_RUN_AS_NODE' } | ForEach-Object { $_.Name })) {
    [Environment]::SetEnvironmentVariable($n, $null, 'Process')
  }
}
function Hide-Ffmpeg {
  # -NoFfmpeg: the new VS Code sees no ffmpeg on PATH, as on a machine without it (to try the
  # first-video offer and the download). Only this process tree's PATH changes.
  $keep = @($env:PATH -split ';' | Where-Object { $_ -and -not (Test-Path (Join-Path $_ 'ffmpeg.exe')) -and -not (Test-Path (Join-Path $_ 'ffmpeg')) })
  $dropped = @($env:PATH -split ';' | Where-Object { $_ -and $keep -notcontains $_ })
  if ($dropped.Count) { Say ("  ffmpeg hidden: removed from PATH: " + ($dropped -join '; ')) } else { Say '  ffmpeg hidden: none was on PATH' }
  if (-not $DryRun) { $env:PATH = $keep -join ';' }
  if ($NoFfmpeg) {
    # Also no lookup in the usual install places (winget, Chocolatey, Scoop, C:fmpeg ...): setup offers the download.
    Say '  ffmpeg hidden: lookup in the usual install places off (VPE_FFMPEG_SEARCH=off)'
    if (-not $DryRun) { $env:VPE_FFMPEG_SEARCH = 'off' }
  }
}
function Link-Or-Copy([string]$from, [string]$to) {
  try { New-Item -ItemType HardLink -Path $to -Target $from -ErrorAction Stop | Out-Null }
  catch { Copy-Item -LiteralPath $from -Destination $to -Force }
}

$settings = @'
{
  "workbench.startupEditor": "none",
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "workbench.tips.enabled": false,
  "workbench.enableExperiments": false,
  "security.workspace.trust.enabled": false,
  "update.mode": "none",
  "update.showReleaseNotes": false,
  "extensions.autoCheckUpdates": false,
  "extensions.autoUpdate": false,
  "extensions.ignoreRecommendations": true,
  "telemetry.telemetryLevel": "off",
  "window.restoreWindows": "none"
}
'@
$utf8 = New-Object Text.UTF8Encoding($false)
$needBuild = (-not $Dev) -and (-not $isVsix)
$buildCmd = "(cd $(Q $buildDir)) npx --yes --prefer-offline @vscode/vsce package -o $(Q $vsix)"
$wtCmd = "git -C $(Q $Main) worktree add --detach $(Q $Src) $sha"
$installCmd = "$(Q $codeCli) --extensions-dir $(Q $ExtDir) --user-data-dir $(Q $UserData) --install-extension $(Q $vsix)"

$launchArgs = @('--user-data-dir', (Q $UserData), '--extensions-dir', (Q $ExtDir), '--new-window', '--skip-release-notes', '--skip-welcome', '--disable-workspace-trust')
if ($Dev) { $launchArgs += ('--extensionDevelopmentPath=' + (Q $buildDir)) }
$launchArgs += (Q $openFolder); $launchArgs += (Q $reviewMd)
$launchCmd = "$(Q $codeExe) $($launchArgs -join ' ')"

if ($DryRun) {
  Say 'Plan:'
  if ($NoFfmpeg -or $NoFfmpegOnPath) { Hide-Ffmpeg }
  if ($fetch) { Cmd "node $(Q $getCode) $codeVersion" }
  if (-not $isVsix -and $buildDir -eq $Src) { Cmd $wtCmd }
  if ($needBuild) { Cmd $buildCmd }
  Cmd "write $(Q (Join-Path $UserData 'User\settings.json'))  (no welcome page, no trust prompt, no updates, telemetry off)"
  if (-not $Dev) { Cmd $installCmd }
  if (-not $Media) {
    foreach ($i in $items) { Cmd "hardlink-or-copy $(Q $i[1]) -> $(Q (Join-Path (Join-Path $Videos $i[0]) $i[2]))" }
    if ($sidecarSrc -and $srt) { Cmd "sidecar pair: $(Q (Join-Path $Videos 'subtitles\long_20s.mp4')) + long_20s.en.srt (from $(Q $srt))" }
  }
  if ($Checklist) { Cmd "copy $(Q $Checklist) -> $(Q $reviewMd)" } else { Cmd "write default $(Q $reviewMd)" }
  Cmd $launchCmd
  if (-not $Keep) {
    if (-not $isVsix -and $buildDir -eq $Src) { Cmd "git -C $(Q $Main) worktree remove --force $(Q $Src)" }
    Cmd "remove $(Q $Work)  (after the window closes)"
  }
  exit 0
}

try {
  New-Item -ItemType Directory -Force -Path $Work | Out-Null
  Clear-VsEnv
  if ($NoFfmpeg -or $NoFfmpegOnPath) { Hide-Ffmpeg }
  if ($fetch) {
    Say "Fetching VS Code $codeVersion ..."
    Cmd "node $(Q $getCode) $codeVersion"
    & node $getCode $codeVersion
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $codeExe)) { Fail "could not fetch VS Code $codeVersion (network? try -Installed)" }
  }
  if (-not $isVsix -and $buildDir -eq $Src) {
    Cmd $wtCmd
    & git -C $Main worktree add --detach $Src $sha | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "git worktree add failed" }
    $madeWorktree = $true
  }
  if ($needBuild) {
    Cmd $buildCmd
    Push-Location $buildDir
    try { & npx.cmd --yes --prefer-offline '@vscode/vsce' package -o $vsix } finally { Pop-Location }
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path $vsix)) {
      Fail "vsce failed. It is fetched with npx on first use (needs network once; later runs use the npm cache). Check 'npx --yes @vscode/vsce --version', or build a .vsix yourself and pass its path."
    }
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $UserData 'User'), $ExtDir | Out-Null
  [IO.File]::WriteAllText((Join-Path $UserData 'User\settings.json'), $settings, $utf8)
  if (-not $Dev) {
    Cmd $installCmd
    $out = & $codeCli --extensions-dir $ExtDir --user-data-dir $UserData --install-extension $vsix
    $out | ForEach-Object { Say "  $_" }
    if ($LASTEXITCODE -ne 0) { Fail "installing the VSIX failed" }
  }
  if (-not $Media) {
    foreach ($i in $items) {
      $d = Join-Path $Videos $i[0]; New-Item -ItemType Directory -Force -Path $d | Out-Null
      Link-Or-Copy $i[1] (Join-Path $d $i[2])
    }
    if ($sidecarSrc -and $srt) {
      $d = Join-Path $Videos 'subtitles'; New-Item -ItemType Directory -Force -Path $d | Out-Null
      Link-Or-Copy $sidecarSrc (Join-Path $d 'long_20s.mp4'); Copy-Item $srt (Join-Path $d 'long_20s.en.srt')
    }
  }
  if ($Checklist) { Copy-Item -LiteralPath $Checklist -Destination $reviewMd -Force }
  else {
    $md = "# Review: $describe`r`n`r`nversion $version, commit $sha, VS Code $codeVersion`r`n`r`n"
    if ($Media) { $md += "Your own folder: $Media`r`n" }
    else {
      $md += "This folder holds linked copies of test clips (deleted when the window closes). Open them and check they play:`r`n`r`n"
      foreach ($g in ($items | ForEach-Object { $_[0] } | Select-Object -Unique)) {
        $md += "## $g`r`n"; foreach ($i in $items) { if ($i[0] -eq $g) { $md += "- [ ] $($i[2])`r`n" } }; $md += "`r`n"
      }
      if ($sidecarSrc -and $srt) { $md += "## subtitles`r`n- [ ] long_20s.mp4 (with long_20s.en.srt next to it)`r`n`r`n" }
      if ($missing.Count) { $md += "Not available here: $($missing -join ', ')`r`n" }
    }
    [IO.File]::WriteAllText($reviewMd, $md, $utf8)
  }
  Say "Launching VS Code ..."
  Cmd $launchCmd
  if ($NoWait) {
    Start-Process -FilePath $codeExe -ArgumentList ($launchArgs -join ' ') | Out-Null
    $Keep = $true; Note "-NoWait: leaving $Work in place; delete it yourself."
  } else {
    Start-Process -FilePath $codeExe -ArgumentList ($launchArgs -join ' ') -Wait | Out-Null
  }
} finally {
  if (-not $Keep) {
    if ($madeWorktree) { & git -C $Main worktree remove --force $Src 2>$null | Out-Null; & git -C $Main worktree prune }
    for ($n = 0; $n -lt 5 -and (Test-Path $Work); $n++) {
      try { Remove-Item -LiteralPath $Work -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Seconds 2 }
    }
    if (Test-Path $Work) { Note "could not fully remove $Work" } else { Say "Cleaned up $Work" }
  } else { Say "Kept: $Work" }
}
