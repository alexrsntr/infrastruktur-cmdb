Infrastruktur CMDB - Windows-Testpaket / Windows test package
==============================================================

DEUTSCH

  Starten:   Doppelklick auf "Start CMDB.cmd". Der erste Start dauert etwa eine Minute.
             Danach öffnet sich der Browser (http://localhost:8080) - dort das
             Administratorkonto anlegen. Fertig.
  Beenden:   das schwarze Fenster schließen (oder darin Strg+C drücken).
  Daten:     liegen im Ordner "data" neben dieser Datei. Zum Sichern den ganzen Ordner
             kopieren, während die CMDB beendet ist. Zum Neuanfang den Ordner löschen.

  Hinweise:
  - Vorher die ZIP-Datei komplett entpacken (Rechtsklick > "Alle extrahieren").
  - Fragt Windows "Möchten Sie diese Datei ausführen?" oder erscheint
    "Der Computer wurde durch Windows geschützt": auf "Ausführen" bzw.
    "Weitere Informationen" > "Trotzdem ausführen" klicken.
  - Die CMDB ist nur auf diesem Computer erreichbar. Für mehrere Benutzer:
    Docker oder Azure, siehe https://github.com/alexrsntr/infrastruktur-cmdb#installation
  - Falls nach einem Absturz noch etwas läuft: "Stop CMDB.cmd" doppelklicken.

ENGLISH

  Start:     double-click "Start CMDB.cmd". The first start takes about a minute.
             Your browser then opens http://localhost:8080 - create your administrator
             account there. Done.
  Stop:      close the black window (or press Ctrl+C in it).
  Data:      in the folder "data" next to this file. To back it up, copy the whole folder
             while the CMDB is stopped. To start from scratch, delete the folder.

  Notes:
  - Unpack the complete ZIP file first (right-click > "Extract All").
  - If Windows asks "Do you want to run this file?" or shows "Windows protected your PC":
    click "Run" or "More info" > "Run anyway".
  - Only this computer can open the CMDB. For several users use Docker or Azure:
    https://github.com/alexrsntr/infrastruktur-cmdb#installation
  - If something is still running after a crash: double-click "Stop CMDB.cmd".

Included: Node.js (MIT license, app\node\LICENSE), PostgreSQL (PostgreSQL license),
Infrastruktur CMDB (MIT license, app\cmdb\LICENSE).
