$baseUrl = "https://mfftkxcfxkqumygendye.supabase.co/storage/v1/object/public/music"

Get-ChildItem -Path music\* -Include *.mp3,*.wav,*.ogg,*.m4a,*.flac,*.aac,*.mp4,*.webm -File |
  ForEach-Object { "$baseUrl/$([uri]::EscapeDataString($_.Name))" } |
  ConvertTo-Json |
  Set-Content music\songs.json

Write-Host "songs.json updated with Supabase Storage URLs."