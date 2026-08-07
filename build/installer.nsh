; Custom NSIS hooks for the Bethaniel Windows installer.
;
; electron-builder's `deleteAppDataOnUninstall` is all-or-nothing, so we keep it
; false and make the choice here instead. Bethaniel stores downloaded GGUF
; models in %APPDATA%\Bethaniel\models — a full catalog is well over 20 GB — so
; silently leaving it behind wastes a lot of disk, and silently deleting it
; would destroy the user's manuscripts. Ask.
;
; customUnInstall is inserted at the top of the uninstall section, before the
; installed files are removed (app-builder-lib/templates/nsis/uninstaller.nsh).

!macro customUnInstall
  ; CRITICAL: the auto-updater runs this same uninstaller with /S and --updated
  ; on every update. Prompting there would either hang on an invisible message
  ; box or wipe the user's models during a routine version bump. ${isUpdated}
  ; covers the update path; ${Silent} covers any other unattended invocation.
  ${ifNot} ${isUpdated}
  ${andIfNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 \
      "Also delete your downloaded AI models, manuscripts and settings?$\r$\n$\r$\nThis frees several GB of disk space, but permanently removes everything you have uploaded or edited. This cannot be undone." \
      /SD IDNO IDNO skipUserData

    ; Electron always writes user data to the *per-user* AppData, so make sure
    ; $APPDATA resolves there even if the uninstaller is running elevated —
    ; same guard electron-builder applies for its own app-data removal.
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    RMDir /r "$APPDATA\${APP_FILENAME}"
    !ifdef APP_PRODUCT_FILENAME
      RMDir /r "$APPDATA\${APP_PRODUCT_FILENAME}"
    !endif

    skipUserData:
  ${endIf}
!macroend
