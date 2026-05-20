[CmdletBinding()]
param(
  [string]$PbfUrl,
  [string]$DataDir,
  [string]$PbfFileName,
  [string]$DockerComposeFile,
  [string]$OsrmImage = 'osrm/osrm-backend:latest',
  [switch]$SkipDownload,
  [switch]$SkipExtract,
  [switch]$SkipContract,
  [switch]$SkipComposeUp
)

$ErrorActionPreference = 'Stop'
$scriptRoot = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }

if (-not $PbfUrl) { $PbfUrl = 'https://download.geofabrik.de/south-america/colombia-latest.osm.pbf' }
if (-not $DataDir) { $DataDir = Join-Path $scriptRoot '..\osrm-data' }
if (-not $PbfFileName) { $PbfFileName = 'region.osm.pbf' }
if (-not $DockerComposeFile) { $DockerComposeFile = Join-Path $scriptRoot '..\docker-compose.osrm.yml' }

function Write-Section {
  param([string]$Title)
  Write-Host ''
  Write-Host ('=' * 72)
  Write-Host $Title
  Write-Host ('=' * 72)
}

function Test-Command {
  param([string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "No se encontró el comando '$Name'. Instálalo y vuelve a intentarlo."
  }
}

function Invoke-External {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string[]]$Arguments,
    [Parameter(Mandatory = $true)][string]$Description
  )

  Write-Host "-> $Description"
  & $FilePath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Falló el paso: $Description (exit code $LASTEXITCODE)"
  }
}

function Resolve-AbsolutePath {
  param([Parameter(Mandatory = $true)][string]$Path)
  return [System.IO.Path]::GetFullPath($Path)
}

function Get-ProjectVolumeName {
  param([Parameter(Mandatory = $true)][string]$Suffix)

  $project = Split-Path -Leaf (Resolve-AbsolutePath (Join-Path $scriptRoot '..'))
  $cleanProject = ($project -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
  $cleanSuffix = ($Suffix -replace '[^a-zA-Z0-9]', '').ToLowerInvariant()
  return "${cleanProject}_${cleanSuffix}"
}

$DataDir = Resolve-AbsolutePath $DataDir
$DockerComposeFile = Resolve-AbsolutePath $DockerComposeFile

Write-Section 'Validaciones iniciales'
Test-Command 'docker'
if (-not (Test-Path $DockerComposeFile)) {
  throw "No se encontró el archivo de compose: $DockerComposeFile"
}

if (-not (Test-Path $DataDir)) {
  New-Item -ItemType Directory -Path $DataDir | Out-Null
}

$pbfPath = Resolve-AbsolutePath (Join-Path $DataDir $PbfFileName)
$osrmBaseName = [System.IO.Path]::GetFileNameWithoutExtension([System.IO.Path]::GetFileNameWithoutExtension($PbfFileName))
$osrmFileName = "$osrmBaseName.osrm"
$volumeName = Get-ProjectVolumeName -Suffix 'osrm_data'
Write-Host "Datos OSRM: $DataDir"
Write-Host "PBF:        $pbfPath"
Write-Host "Compose:    $DockerComposeFile"
Write-Host "Imagen:     $OsrmImage"
Write-Host "Volumen:    $volumeName"

Write-Section 'Verificación del volumen'
Invoke-External `
  -FilePath 'docker' `
  -Arguments @('run', '--rm', '-v', "${volumeName}:/data", $OsrmImage, 'sh', '-lc', 'test -w /data && echo OK: volumen escribible') `
  -Description 'Comprobando acceso al volumen desde Docker'

if (-not $SkipDownload) {
  Write-Section 'Descarga del PBF'
  if (Test-Path $pbfPath) {
    Write-Host "El archivo ya existe: $pbfPath"
  } else {
    Write-Host "Descargando desde: $PbfUrl"
    Invoke-WebRequest -Uri $PbfUrl -OutFile $pbfPath
  }
}

Write-Section 'Sincronización al volumen Docker'
Invoke-External `
  -FilePath 'docker' `
  -Arguments @('run', '--rm', '-v', "${volumeName}:/data", '-v', "$($DataDir):/host", 'alpine:3.20', 'sh', '-lc', "cp /host/$PbfFileName /data/$PbfFileName") `
  -Description 'Copiando PBF al volumen Docker'

if (-not $SkipExtract) {
  Write-Section 'Extracción OSRM'
  if (-not (Test-Path $pbfPath)) {
    throw "No existe el PBF requerido: $pbfPath"
  }

  Invoke-External `
    -FilePath 'docker' `
    -Arguments @('run', '--rm', '--user', '0:0', '-v', "${volumeName}:/data", $OsrmImage, 'osrm-extract', '-p', '/opt/car.lua', "/data/$PbfFileName") `
    -Description 'Ejecutando osrm-extract'
}

if (-not $SkipContract) {
  Write-Section 'Contracción OSRM'
  Invoke-External `
    -FilePath 'docker' `
    -Arguments @('run', '--rm', '--user', '0:0', '-v', "${volumeName}:/data", $OsrmImage, 'sh', '-lc', "test -f /data/$osrmFileName && echo 'OK: archivo base listo en /data/$osrmFileName'") `
    -Description 'Comprobando archivo base OSRM en el volumen'

  Invoke-External `
    -FilePath 'docker' `
    -Arguments @('run', '--rm', '--user', '0:0', '-v', "${volumeName}:/data", $OsrmImage, 'osrm-contract', "/data/$osrmFileName") `
    -Description 'Ejecutando osrm-contract'
}

if (-not $SkipComposeUp) {
  Write-Section 'Arranque de OSRM'
  Push-Location (Split-Path -Path $DockerComposeFile -Parent)
  try {
    if (Get-Command 'docker-compose' -ErrorAction SilentlyContinue) {
      Invoke-External -FilePath 'docker-compose' -Arguments @('-f', (Split-Path -Leaf $DockerComposeFile), 'up', '-d') -Description 'Levantando OSRM con docker-compose'
    } else {
      Invoke-External -FilePath 'docker' -Arguments @('compose', '-f', (Split-Path -Leaf $DockerComposeFile), 'up', '-d') -Description 'Levantando OSRM con docker compose'
    }
  } finally {
    Pop-Location
  }
}

Write-Section 'Completado'
Write-Host 'OSRM quedó preparado. Prueba:'
Write-Host '  curl "http://localhost:5000/route/v1/driving/-76.5320,3.4516;-76.5300,3.4520?overview=false"'
Write-Host ''
Write-Host 'Si quieres apuntar la app a esta instancia local:'
Write-Host '  $env:OSRM_BASE_URL = ''http://127.0.0.1:5000'''
Write-Host '  npm start'
