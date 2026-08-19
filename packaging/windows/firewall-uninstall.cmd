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
exit /b 0
