# Sends the `wifi` command to the board over serial and shows its reply, so
# nobody has to type into a scrolling monitor. The password is read hidden
# and is never printed or saved on the PC.
#
#   powershell -ExecutionPolicy Bypass -File firmware\tools\set_wifi.ps1 [-Port COM3] [-Clear]
#
# Close any serial monitor first: only one program can hold the port.
param([string]$Port, [switch]$Clear)

if (-not $Port) {
    $Port = [System.IO.Ports.SerialPort]::GetPortNames() | Where-Object { $_ -ne 'COM1' } | Select-Object -First 1
    if (-not $Port) { Write-Host 'No serial port found: is the board plugged in?' -ForegroundColor Red; exit 1 }
}

if ($Clear) {
    $line = 'wifi clear'
} else {
    $ssid = Read-Host 'Wi-Fi name (2.4 GHz network)'
    if (-not $ssid) { Write-Host 'No network name given.' -ForegroundColor Red; exit 1 }
    $secure = Read-Host 'Wi-Fi password (hidden; leave empty for an open network)' -AsSecureString
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    try {
        $pass = [Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
    } finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    if ($ssid.Contains(' ')) { $ssid = '"' + $ssid + '"' }
    $line = ('wifi ' + $ssid + ' ' + $pass).TrimEnd()
}

# DTR/RTS stay low so opening the port does not reset the board
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200
$sp.DtrEnable = $false
$sp.RtsEnable = $false
$sp.ReadTimeout = 200
try {
    $sp.Open()
} catch {
    Write-Host "Could not open ${Port}: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host 'Close the serial monitor (Ctrl+C in its tab) and run this again.'
    exit 1
}

Write-Host "Sending to the board on $Port ..."
$sp.Write($line + "`n")
$line = $null
$pass = $null

# Show the board's reply until it is calibrating on the new link, or gives up
$deadline = (Get-Date).AddSeconds(60)
$done = $false
while ((Get-Date) -lt $deadline -and -not $done) {
    try { $text = $sp.ReadLine() } catch [TimeoutException] { continue }
    $text = $text.TrimEnd("`r")
    Write-Host $text
    if ($text -match 'calibrating 1/' -or $text -match 'falling back to sniffer' -or $text -match 'could not save') {
        $done = $true
    }
}
$sp.Close()

Write-Host ''
Write-Host 'Open the monitor to keep watching:'
Write-Host '  & "$env:USERPROFILE\.platformio\penv\Scripts\pio.exe" device monitor -d firmware -e esp32dev'
