# 一键构建 + 部署到 Cloudflare Pages（39-blog）
#
# 为什么需要这个脚本：
#   `wrangler pages deploy` 只从**当前工作目录**找 `functions/` 和 `wrangler.toml`。
#   之前 cd 到临时目录跑 deploy，站点文件传上去了但 Functions 没带上，
#   结果 /api/tw、/api/admin/* 全部 404/405，留言板和后台就"用不了"了。
#   现在固定从站点根目录运行（wrangler.toml 和 functions/ 都在这里），
#   并在输出里强制校验 "Uploading Functions bundle"，缺了就直接报错。
#
# 用法：pwsh -File scripts/deploy-pages.ps1 [-Message "描述"]

param(
	[string]$Message = "deploy from scripts/deploy-pages.ps1",
	[string]$ProjectName = "39-blog",
	[string]$Branch = "main",
	# wrangler 安装目录（里面有 node_modules/.bin/wrangler.CMD），只用来找可执行文件
	[string]$WranglerHome = $(if ($env:WRANGLER_HOME) { $env:WRANGLER_HOME } else { "C:\Users\shilin\AppData\Local\Temp\cf2" })
)

$ErrorActionPreference = "Stop"
$site = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $WranglerHome "node_modules\.bin\wrangler.CMD"
if (-not (Test-Path $wrangler)) { throw "找不到 wrangler: $wrangler（用 -WranglerHome 指定）" }
if (-not (Test-Path (Join-Path $site "wrangler.toml"))) { throw "站点根目录缺少 wrangler.toml（R2 绑定在这里声明）" }

Push-Location $site
try {
	$env:CI = "1"
	Write-Host "== 构建 ==" -ForegroundColor Cyan
	node node_modules\astro\astro.js build --force
	if ($LASTEXITCODE -ne 0) { throw "astro build 失败" }

	Write-Host "== 重建搜索索引 ==" -ForegroundColor Cyan
	& (Join-Path $site "node_modules\.bin\pagefind.CMD") --site dist
	if ($LASTEXITCODE -ne 0) { throw "pagefind 失败" }

	Write-Host "== 部署（cwd = 站点根，functions/ 与 wrangler.toml 都会被带上）==" -ForegroundColor Cyan
	# 用临时 .cmd 批处理来跑：直接 `& wrangler.CMD … 2>&1` 在脚本里会被
	# $ErrorActionPreference=Stop 和 stderr 搅在一起（出现过「静默 exit 1 无输出」），
	# 而 Start-Process 传带空格的参数又会被拆坏，所以把完整命令写进批处理，重定向也在里面做。
	$log = Join-Path $env:TEMP "pages-deploy.log"
	$bat = Join-Path $env:TEMP "pages-deploy.cmd"
	if (Test-Path $log) { Remove-Item $log -Force }
	$lines = @(
		"@echo off",
		"`"$wrangler`" pages deploy dist --project-name=$ProjectName --branch=$Branch --commit-message `"$Message`" --commit-dirty=true > `"$log`" 2>&1"
	)
	[System.IO.File]::WriteAllLines($bat, $lines, (New-Object System.Text.UTF8Encoding($false)))
	$proc = Start-Process -FilePath "cmd.exe" -ArgumentList @("/c", "`"$bat`"") -WorkingDirectory $site -NoNewWindow -Wait -PassThru
	$out = if (Test-Path $log) { Get-Content $log } else { @() }
	$out | ForEach-Object { $_ }
	if ($proc.ExitCode -ne 0) { throw "wrangler pages deploy 失败（exit $($proc.ExitCode)）" }
	if (-not ($out -match "Uploading Functions bundle")) {
		throw "本次部署没有包含 Functions（输出里没有 'Uploading Functions bundle'），留言板/后台会 405。请检查 functions 目录。"
	}
	Write-Host "== 部署完成（Functions 已包含）==" -ForegroundColor Green
} finally { Pop-Location }
