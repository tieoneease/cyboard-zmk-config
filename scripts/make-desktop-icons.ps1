# Regenerate platform icon sizes from tools/desktop/assets/icon.png (1024px source).
# The PNG is a rasterization of icon.svg, which reuses the workbench's paired-half mark.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$root = Join-Path $PSScriptRoot '..\tools\desktop\assets'
$source = [System.Drawing.Image]::FromFile((Join-Path $root 'icon.png'))
$iconset = Join-Path $root 'icon.iconset'
[System.IO.Directory]::CreateDirectory($iconset) | Out-Null
function Resize-Icon([int]$size, [string]$target) {
    $bitmap = New-Object System.Drawing.Bitmap $size,$size
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    try {
        $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $graphics.DrawImage($source, 0, 0, $size, $size)
        $bitmap.Save($target, [System.Drawing.Imaging.ImageFormat]::Png)
    } finally { $graphics.Dispose(); $bitmap.Dispose() }
}
try {
    foreach ($size in @(16, 32, 128, 256, 512)) {
        Resize-Icon $size (Join-Path $iconset "icon_${size}x${size}.png")
        Resize-Icon ($size * 2) (Join-Path $iconset "icon_${size}x${size}@2x.png")
    }
    $sizes = @(16, 32, 48, 256)
    $images = @()
    foreach ($size in $sizes) {
        $temp = Join-Path $root "icon-$size.tmp.png"
        Resize-Icon $size $temp
        $images += ,([System.IO.File]::ReadAllBytes($temp))
        Remove-Item $temp
    }
    $writer = New-Object System.IO.BinaryWriter ([System.IO.File]::Create((Join-Path $root 'icon.ico')))
    try {
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$sizes.Count)
        $offset = 6 + 16 * $sizes.Count
        for ($i = 0; $i -lt $sizes.Count; $i++) {
            $dimension = if ($sizes[$i] -eq 256) { 0 } else { $sizes[$i] }
            $writer.Write([byte]$dimension); $writer.Write([byte]$dimension)
            $writer.Write([byte]0); $writer.Write([byte]0)
            $writer.Write([uint16]1); $writer.Write([uint16]32)
            $writer.Write([uint32]$images[$i].Length); $writer.Write([uint32]$offset)
            $offset += $images[$i].Length
        }
        foreach ($image in $images) { $writer.Write([byte[]]$image) }
    } finally { $writer.Dispose() }
} finally { $source.Dispose() }
