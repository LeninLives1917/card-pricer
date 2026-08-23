$ProgressPreference = 'SilentlyContinue'
$ErrorActionPreference = 'Stop'
$url = 'https://downloads.s3.cardmarket.com/productCatalog/priceGuide/price_guide_6.json'
$outDir = 'C:\Users\daith\OneDrive\Desktop\card-pricer\data\weekly-market'
$today = Get-Date -Format 'yyyy-MM-dd'
$outFile = Join-Path $outDir "$today.txt"

if (Test-Path $outFile) {
    Write-Output "SKIP: $outFile already exists, not overwriting"
    exit 0
}

try {
    $resp = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 120
} catch {
    Write-Output "FETCH_FAILED: $($_.Exception.Message)"
    exit 1
}

Write-Output "FETCHED status=$($resp.StatusCode) bytes=$($resp.RawContentLength)"

try {
    $data = $resp.Content | ConvertFrom-Json
} catch {
    Write-Output "PARSE_FAILED: $($_.Exception.Message)"
    exit 1
}

$pg = $data.priceGuides
Write-Output "TOTAL_ENTRIES: $($pg.Count)"

$reduced = [ordered]@{}
foreach ($p in $pg) {
    if ($null -ne $p.avg -and $p.avg -ge 5) {
        $reduced[[string]$p.idProduct] = $p.avg
    }
}
Write-Output "REDUCED_ENTRIES: $($reduced.Count)"

$reducedJson = $reduced | ConvertTo-Json -Compress
Set-Content -Path $outFile -Value $reducedJson -NoNewline -Encoding UTF8
Write-Output "WROTE: $outFile"
Write-Output "CREATED_AT: $($data.createdAt)"
