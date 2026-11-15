# 一键构建 + 部署到 Cloudflare Pages（39-blog）
#
# 为什么需要这个脚本：
#   `wrangler pages deploy` 只从**当前工作目录**找 `functions/`。之前直接 cd 到临时目录
#   跑 deploy，虽然站点文件传上去了，但 Functions 没被带上，结果 /api/tw、/api/admin/*
#   全部 404/405，留言板和后台就"用不了"了。这里把 functions 复制到 wrangler 所在目录，
#   并在输出里强制校验 "Uploading Functions bundle"，缺了就直接报错。
#
# 用法：pwsh -File scripts/deploy-pages.ps1 [-Message "描述"]

param(
	[string]$Message = "deploy from scripts/deploy-pages.ps1",
	[string]$ProjectName = "39-blog",
	[string]$Branch = "main",
	# wrangler 安装目录（里面有 node_modules/.bin/wrangler.CMD）
	[string]$WranglerHome = $(if ($env:WRANGLER_HOME) { $env:WRANGLER_HOME } else { "C:\Users\shilin\AppData\Local\Temp\cf2" })
)

$ErrorActionPreference = "Stop"
$site = Split-Path -Parent $PSScriptRoot
$wrangler = Join-Path $WranglerHome "node_modules\.bin\wrangler.CMD"
if (-not (Test-Path $wrangler)) { throw "找不到 wrangler: $wrangler（用 -WranglerHome 指定）" }

Push-Location $site
try {
	$env:CI = "1"
	Write-Host "== 构建 ==" -ForegroundColor Cyan
	node node_modules\astro\astro.js build --force
	if ($LASTEXITCODE -ne 0) { throw "astro build 失败" }

	Write-Host "== 重建搜索索引 ==" -ForegroundColor Cyan
	& (Join-Path $site "node_modules\.bin\pagefind.CMD") --site dist
	if ($LASTEXITCODE -ne 0) { throw "pagefind 失败" }

	Write-Host "== 同步 functions 到 wrangler 目录 ==" -ForegroundColor Cyan
	$stageFunctions = Join-Path $WranglerHome "functions"
	if (Test-Path $stageFunctions) { Remove-Item $stageFunctions -Recurse -Force }
	Copy-Item -Recurse (Join-Path $site "functions") $stageFunctions

	Write-Host "== 部署 ==" -ForegroundColor Cyan
	Push-Location $WranglerHome
	try {
		$out = & $wrangler pages deploy (Join-Path $site "dist") --project-name=$ProjectName --branch=$Branch --commit-message $Message 2>&1
		$out | ForEach-Object { $_ }
		if ($LASTEXITCODE -ne 0) { throw "wrangler pages deploy 失败" }
		if (-not ($out -match "Uploading Functions bundle")) {
			throw "本次部署没有包含 Functions（输出里没有 'Uploading Functions bundle'），留言板/后台会 405。请检查 functions 目录。"
		}
		Write-Host "== 部署完成（Functions 已包含）==" -ForegroundColor Green
	} finally { Pop-Location }
} finally { Pop-Location }
