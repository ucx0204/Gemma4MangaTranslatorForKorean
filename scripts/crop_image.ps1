param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][int]$X,
  [Parameter(Mandatory = $true)][int]$Y,
  [Parameter(Mandatory = $true)][int]$Width,
  [Parameter(Mandatory = $true)][int]$Height,
  [Parameter(Mandatory = $true)][int]$MinSide,
  [Parameter(Mandatory = $true)][int]$MaxSide
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$bitmap = [System.Drawing.Bitmap]::FromFile($Path)
try {
  $cropRect = New-Object System.Drawing.Rectangle($X, $Y, $Width, $Height)
  $cropped = $bitmap.Clone($cropRect, $bitmap.PixelFormat)
  try {
    $targetWidth = $cropped.Width
    $targetHeight = $cropped.Height
    $shortSide = [Math]::Min($targetWidth, $targetHeight)
    $longSide = [Math]::Max($targetWidth, $targetHeight)
    $scale = 1.0

    if ($shortSide -gt 0 -and $shortSide -lt $MinSide) {
      $scale = $MinSide / [double]$shortSide
    }

    if (($longSide * $scale) -gt $MaxSide) {
      $scale = $scale * ($MaxSide / [double]($longSide * $scale))
    }

    if ([Math]::Abs($scale - 1.0) -gt 0.01) {
      $targetWidth = [Math]::Max(1, [int][Math]::Round($cropped.Width * $scale))
      $targetHeight = [Math]::Max(1, [int][Math]::Round($cropped.Height * $scale))
      $resized = New-Object System.Drawing.Bitmap($targetWidth, $targetHeight)
      try {
        $graphics = [System.Drawing.Graphics]::FromImage($resized)
        try {
          $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
          $graphics.DrawImage($cropped, 0, 0, $targetWidth, $targetHeight)
        } finally {
          $graphics.Dispose()
        }

        $cropped.Dispose()
        $cropped = $resized
      } catch {
        $resized.Dispose()
        throw
      }
    }

    $stream = New-Object System.IO.MemoryStream
    try {
      $cropped.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
      [Console]::Out.Write([Convert]::ToBase64String($stream.ToArray()))
    } finally {
      $stream.Dispose()
    }
  } finally {
    $cropped.Dispose()
  }
} finally {
  $bitmap.Dispose()
}
