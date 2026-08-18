#Requires -RunAsAdministrator
param(
    [int]$Port = 3000
)

$ErrorActionPreference = 'Stop'

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "PORT must be between 1 and 65535."
}

$ranges = @(
    @{ Name = 'Minecraft Manager web'; Proto = 'TCP'; LocalPort = "$Port" },
    @{ Name = 'Minecraft Manager Bedrock IPv6 18132-18199'; Proto = 'UDP'; LocalPort = '18132-18199' },
    @{ Name = 'Minecraft Manager Bedrock IPv4 19132-19199'; Proto = 'UDP'; LocalPort = '19132-19199' },
    @{ Name = 'Minecraft Manager Phantom 19200-19299'; Proto = 'UDP'; LocalPort = '19200-19299' },
    @{ Name = 'Minecraft Manager Bedrock IPv6 24565-24665'; Proto = 'UDP'; LocalPort = '24565-24665' },
    @{ Name = 'Minecraft Manager Bedrock IPv4 25565-25665'; Proto = 'UDP'; LocalPort = '25565-25665' },
    @{ Name = 'Minecraft Manager Bedrock IPv6 29000-29100'; Proto = 'UDP'; LocalPort = '29000-29100' },
    @{ Name = 'Minecraft Manager Bedrock IPv4 30000-30100'; Proto = 'UDP'; LocalPort = '30000-30100' }
)

foreach ($rule in $ranges) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Firewall rule already exists: $($rule.Name)"
        continue
    }
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol $rule.Proto `
        -LocalPort $rule.LocalPort `
        -Profile Any | Out-Null
    Write-Host "Added firewall rule: $($rule.Name)"
}

Write-Host
Write-Host "Windows Firewall now allows TCP $Port and the manager Bedrock UDP ranges."
Write-Host "DNS port 53 is not opened here. Windows often owns that port; set console DNS only if you bind it yourself."
