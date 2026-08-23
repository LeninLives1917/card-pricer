$ErrorActionPreference = 'Stop'
$dir = 'C:\Users\daith\OneDrive\Desktop\card-pricer\data\weekly-market'
$today = Get-Date -Format 'yyyy-MM-dd'
$snapFile = Join-Path $dir "$today.txt"
$wlFile = Join-Path $dir 'watchlist.tsv'

$snapRaw = Get-Content $snapFile -Raw | ConvertFrom-Json
$snap = @{}
$snapRaw.PSObject.Properties | ForEach-Object { $snap[$_.Name] = $_.Value }

$rows = Import-Csv -Path $wlFile -Delimiter "`t"
Write-Output "WATCHLIST_ROWS: $($rows.Count)"

$matched = 0
$results = @()
foreach ($r in $rows) {
    $cur = $snap[$r.idProduct]
    if ($null -ne $cur -and $r.baseline_avg -as [double]) {
        $base = [double]$r.baseline_avg
        if ($base -gt 0) {
            $pct = (($cur / $base) - 1) * 100
            $results += [PSCustomObject]@{
                idProduct = $r.idProduct
                name = $r.name
                list = $r.list
                baseline = $base
                current = $cur
                pct = [math]::Round($pct,1)
            }
            $matched++
        }
    }
}
Write-Output "MATCHED: $matched"

$groups = $results | Group-Object list
foreach ($g in $groups) {
    $pcts = $g.Group.pct | Sort-Object
    $n = $pcts.Count
    if ($n -eq 0) { continue }
    $median = if ($n % 2 -eq 1) { $pcts[[math]::Floor($n/2)] } else { ($pcts[$n/2 -1] + $pcts[$n/2]) / 2 }
    $up = ($g.Group | Where-Object { $_.pct -gt 0 }).Count
    $best = $g.Group | Sort-Object pct -Descending | Select-Object -First 1
    $worst = $g.Group | Sort-Object pct | Select-Object -First 1
    $pctUp = [math]::Round(100.0 * $up / $n, 0)
    Write-Output "LIST=$($g.Name) N=$n MEDIAN=$median PCTUP=$pctUp% BEST=$($best.name)|$($best.pct)% WORST=$($worst.name)|$($worst.pct)%"
}

Write-Output "---TOP15---"
$results | Sort-Object pct -Descending | Select-Object -First 15 | ForEach-Object { Write-Output "$($_.name) [$($_.list)] $($_.baseline) -> $($_.current) ($($_.pct)%)" }
Write-Output "---BOTTOM15---"
$results | Sort-Object pct | Select-Object -First 15 | ForEach-Object { Write-Output "$($_.name) [$($_.list)] $($_.baseline) -> $($_.current) ($($_.pct)%)" }
