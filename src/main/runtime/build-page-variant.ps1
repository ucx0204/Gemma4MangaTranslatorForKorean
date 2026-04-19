param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [int]$MaxLongSide = 1900,
  [double]$Contrast = 1.35,
  [switch]$Grayscale
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

function Get-ScaledSize([int]$width, [int]$height, [int]$maxLongSide) {
  $longSide = [Math]::Max($width, $height)
  if ($longSide -le 0 -or $longSide -le $maxLongSide) {
    return @{ Width = $width; Height = $height }
  }

  $scale = $maxLongSide / [double]$longSide
  return @{
    Width = [Math]::Max(1, [int][Math]::Round($width * $scale))
    Height = [Math]::Max(1, [int][Math]::Round($height * $scale))
  }
}

function New-ContrastMatrix([double]$contrast, [bool]$grayscale) {
  $translation = (1.0 - $contrast) / 2.0
  if ($grayscale) {
    return New-Object System.Drawing.Imaging.ColorMatrix (, @(
      @([single](0.299 * $contrast), [single](0.299 * $contrast), [single](0.299 * $contrast), [single]0, [single]0),
      @([single](0.587 * $contrast), [single](0.587 * $contrast), [single](0.587 * $contrast), [single]0, [single]0),
      @([single](0.114 * $contrast), [single](0.114 * $contrast), [single](0.114 * $contrast), [single]0, [single]0),
      @([single]0, [single]0, [single]0, [single]1, [single]0),
      @([single]$translation, [single]$translation, [single]$translation, [single]0, [single]1)
    ))
  }

  return New-Object System.Drawing.Imaging.ColorMatrix (, @(
    @([single]$contrast, [single]0, [single]0, [single]0, [single]0),
    @([single]0, [single]$contrast, [single]0, [single]0, [single]0),
    @([single]0, [single]0, [single]$contrast, [single]0, [single]0),
    @([single]0, [single]0, [single]0, [single]1, [single]0),
    @([single]$translation, [single]$translation, [single]$translation, [single]0, [single]1)
  ))
}

$bitmap = [System.Drawing.Bitmap]::FromFile($Path)
try {
  $scaled = Get-ScaledSize -width $bitmap.Width -height $bitmap.Height -maxLongSide $MaxLongSide
  $canvas = New-Object System.Drawing.Bitmap($scaled.Width, $scaled.Height)
  try {
    $graphics = [System.Drawing.Graphics]::FromImage($canvas)
    try {
      $graphics.Clear([System.Drawing.Color]::White)
      $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality

      $attributes = New-Object System.Drawing.Imaging.ImageAttributes
      try {
        $matrix = New-ContrastMatrix -contrast $Contrast -grayscale $Grayscale.IsPresent
        $attributes.SetColorMatrix($matrix)
        $graphics.DrawImage(
          $bitmap,
          [System.Drawing.Rectangle]::FromLTRB(0, 0, $scaled.Width, $scaled.Height),
          0,
          0,
          $bitmap.Width,
          $bitmap.Height,
          [System.Drawing.GraphicsUnit]::Pixel,
          $attributes
        )
      } finally {
        $attributes.Dispose()
      }
    } finally {
      $graphics.Dispose()
    }

    $outputDir = Split-Path -Parent $OutputPath
    if ($outputDir -and -not (Test-Path -LiteralPath $outputDir)) {
      New-Item -ItemType Directory -Path $outputDir | Out-Null
    }

    $canvas.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $canvas.Dispose()
  }
} finally {
  $bitmap.Dispose()
}
