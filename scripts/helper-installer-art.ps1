param([Parameter(Mandatory=$true)][string]$OutputDirectory)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
$projectPath=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$resolvedOutput=[IO.Path]::GetFullPath($OutputDirectory)
if(-not $resolvedOutput.StartsWith((Join-Path $projectPath 'artifacts')+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Artwork output must stay inside workspace artifacts'}
$mark=[Drawing.Image]::FromFile((Join-Path $projectPath 'dist\core\icons\green\icon48.png'))
try {
    $image=[Drawing.Bitmap]::new(240,480)
    $canvas=[Drawing.Graphics]::FromImage($image)
    $canvas.Clear([Drawing.ColorTranslator]::FromHtml('#142627'))
    $canvas.SmoothingMode=[Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $canvas.InterpolationMode=[Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $canvas.DrawImage($mark,32,50,84,84)
    $heading=[Drawing.Font]::new('Segoe UI',21,[Drawing.FontStyle]::Bold)
    $normal=[Drawing.Font]::new('Segoe UI',12)
    $small=[Drawing.Font]::new('Segoe UI',10)
    $foreground=[Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#e3f2f0'))
    $muted=[Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#a4c4c1'))
    $accent=[Drawing.Pen]::new([Drawing.ColorTranslator]::FromHtml('#71c9b7'),3)
    try {
        $canvas.DrawString('TabSpace',$heading,$foreground,28,170)
        $canvas.DrawString('& Drag Group',$normal,$muted,31,210)
        $canvas.DrawLine($accent,32,264,118,264)
        $canvas.DrawString("One helper.`nTwo extensions.",$normal,$foreground,31,294)
        $canvas.DrawString('Designed by kechos',$small,$muted,31,435)
        $image.Save((Join-Path $resolvedOutput 'wizard.bmp'),[Drawing.Imaging.ImageFormat]::Bmp)
    } finally {$heading.Dispose();$normal.Dispose();$small.Dispose();$foreground.Dispose();$muted.Dispose();$accent.Dispose();$canvas.Dispose();$image.Dispose()}
    foreach($theme in @('light','dark')){
        $image=[Drawing.Bitmap]::new(58,58)
        $canvas=[Drawing.Graphics]::FromImage($image)
        try {
            $canvas.Clear($(if($theme -eq 'dark'){[Drawing.ColorTranslator]::FromHtml('#202020')}else{[Drawing.Color]::White}))
            $canvas.DrawImage($mark,5,5,48,48)
            $name=if($theme -eq 'dark'){'wizard-small-dark.bmp'}else{'wizard-small.bmp'}
            $image.Save((Join-Path $resolvedOutput $name),[Drawing.Imaging.ImageFormat]::Bmp)
        } finally {$canvas.Dispose();$image.Dispose()}
    }
} finally {$mark.Dispose()}
