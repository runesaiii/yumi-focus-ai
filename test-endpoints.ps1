param(
  [Parameter(Mandatory=$true)][string]$BaseUrl,
  [string]$Task = "Is this page relevant to the user's current task?",
  [string]$TabTitle = "Example Tab",
  [string]$CheckUrl = "https://example.com",
  [int]$FocusMinutesPlanned = 25,
  [int]$ActualFocusMs = 1500000,
  [string[]]$DistractionsSaved = @("Social media", "Email"),
  [string[]]$TabsAdded = @("https://example.com/article1", "https://example.com/article2")
)

function TryInvoke($scriptBlock) {
  try {
    & $scriptBlock
  } catch {
    Write-Host "ERROR:" $_.Exception.Message -ForegroundColor Red
  }
}

Write-Host "Testing GET $BaseUrl/health" -ForegroundColor Cyan
TryInvoke { $h = Invoke-RestMethod -Uri "$BaseUrl/health" -Method Get -TimeoutSec 30; $h | ConvertTo-Json -Depth 5 | Write-Host }

Write-Host "`nTesting POST $BaseUrl/check" -ForegroundColor Cyan
$checkBody = @{ task = $Task; tabTitle = $TabTitle; url = $CheckUrl } | ConvertTo-Json
TryInvoke {
  $r = Invoke-RestMethod -Uri "$BaseUrl/check" -Method Post -ContentType 'application/json' -Body $checkBody -TimeoutSec 60
  $r | ConvertTo-Json -Depth 6 | Write-Host
}

Write-Host "`nTesting POST $BaseUrl/summary" -ForegroundColor Cyan
$summaryBody = @{
  task = $Task
  focusMinutesPlanned = $FocusMinutesPlanned
  actualFocusMs = $ActualFocusMs
  distractionsSaved = $DistractionsSaved
  tabsAdded = $TabsAdded
} | ConvertTo-Json -Depth 6
TryInvoke {
  $s = Invoke-RestMethod -Uri "$BaseUrl/summary" -Method Post -ContentType 'application/json' -Body $summaryBody -TimeoutSec 60
  $s | ConvertTo-Json -Depth 6 | Write-Host
}

Write-Host "`nDone." -ForegroundColor Green