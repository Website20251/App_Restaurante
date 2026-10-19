!macro customInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Restaurante"'
  nsExec::Exec 'netsh advfirewall firewall add rule name="Restaurante" dir=in action=allow protocol=TCP localport=3000 profile=private,domain,public'
!macroend
!macro customUnInstall
  nsExec::Exec 'netsh advfirewall firewall delete rule name="Restaurante"'
!macroend
