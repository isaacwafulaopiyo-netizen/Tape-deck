# Lists whatever is actually sitting in your Supabase 'music' bucket right
# now, and builds songs.json to match it -- use this after uploading files
# directly through the Supabase dashboard (not through the app's own
# upload button).

$projectUrl = "https://mfftkxcfxkqumygendye.supabase.co"
$anonKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1mZnRreGNmeGtxdW15Z2VuZHllIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODQ4OTE2MTQsImV4cCI6MjEwMDQ2NzYxNH0.PDaSJzmUi-bR3xkX4miteew5NvVer9DQuy2lsAHrL8E"

$headers = @{
  "apikey" = $anonKey
  "Authorization" = "Bearer $anonKey"
  "Content-Type" = "application/json"
}
$body = @{
  prefix = ""
  limit = 1000
  offset = 0
  sortBy = @{ column = "name"; order = "asc" }
} | ConvertTo-Json

$response = Invoke-RestMethod -Uri "$projectUrl/storage/v1/object/list/music" -Method Post -Headers $headers -Body $body

# Real files have an id; folder placeholders don't -- skip those.
$fileNames = $response | Where-Object { $_.id -ne $null } | Select-Object -ExpandProperty name

if($fileNames.Count -eq 0){
  Write-Host "No files found. Either the bucket is empty, or your files ended up nested in a subfolder -- check the Supabase Storage dashboard to confirm they're sitting at the top level of the 'music' bucket, not inside another folder."
} else {
  $baseUrl = "$projectUrl/storage/v1/object/public/music"
  $urls = $fileNames | ForEach-Object { "$baseUrl/$([uri]::EscapeDataString($_))" }
  $urls | ConvertTo-Json | Set-Content music\songs.json
  Write-Host "songs.json updated with $($fileNames.Count) song(s) from Supabase Storage."
}