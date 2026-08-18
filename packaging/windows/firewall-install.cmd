@echo off
setlocal
set "RULE=Minecraft Bedrock Manager"
netsh advfirewall firewall delete rule name="%RULE% Web" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% DNS UDP" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% DNS TCP" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 18132-18199" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 19132-19199" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 19200-19299" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 24565-24665" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 25565-25665" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 29000-29100" >nul 2>&1
netsh advfirewall firewall delete rule name="%RULE% Bedrock UDP 30000-30100" >nul 2>&1

netsh advfirewall firewall add rule name="%RULE% Web" dir=in action=allow protocol=TCP localport=3000 profile=any
netsh advfirewall firewall add rule name="%RULE% DNS UDP" dir=in action=allow protocol=UDP localport=53 profile=any
netsh advfirewall firewall add rule name="%RULE% DNS TCP" dir=in action=allow protocol=TCP localport=53 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 18132-18199" dir=in action=allow protocol=UDP localport=18132-18199 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 19132-19199" dir=in action=allow protocol=UDP localport=19132-19199 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 19200-19299" dir=in action=allow protocol=UDP localport=19200-19299 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 24565-24665" dir=in action=allow protocol=UDP localport=24565-24665 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 25565-25665" dir=in action=allow protocol=UDP localport=25565-25665 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 29000-29100" dir=in action=allow protocol=UDP localport=29000-29100 profile=any
netsh advfirewall firewall add rule name="%RULE% Bedrock UDP 30000-30100" dir=in action=allow protocol=UDP localport=30000-30100 profile=any
exit /b 0
