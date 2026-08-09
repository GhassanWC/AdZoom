# Code signing

Signing is **opt-in via environment variables**. With none set, packaging
produces an unsigned build that installs and runs — Windows will show a
SmartScreen "unrecognised app" warning, and macOS Gatekeeper will refuse it
outright.

## Windows

You need an **OV or EV code-signing certificate** from a CA (DigiCert, Sectigo,
SSL.com, …). EV certificates clear SmartScreen reputation immediately; OV
certificates build reputation over time and downloads.

Since June 2023 CAs must issue code-signing keys on hardware (HSM/token/cloud
KMS), so a plain `.pfx` file is only possible for certificates issued before
that, or via a cloud signing service that exposes one.

```bash
# PowerShell
$env:WINDOWS_CERTIFICATE_FILE = "C:\secure\framevo.pfx"
$env:WINDOWS_CERTIFICATE_PASSWORD = "…"
npm run desktop:package
```

Both the packaged `Framevo.exe` and the generated `Framevo-Setup.exe` are
signed, and the timestamp server (`timestamp.digicert.com`) is set so
signatures stay valid after the certificate expires.

For an HSM/cloud-KMS certificate, use Forge's `windowsSign.hookFunction` (or
electron-winstaller's `signWithParams`) to call your provider's signing tool
instead — the rest of the pipeline is unchanged.

Verify:

```powershell
Get-AuthenticodeSignature .\out\make\squirrel.windows\x64\Framevo-Setup.exe |
  Format-List Status, SignerCertificate
```

## macOS

```bash
export APPLE_ID="you@example.com"
export APPLE_ID_PASSWORD="app-specific-password"   # NOT your Apple ID password
export APPLE_TEAM_ID="XXXXXXXXXX"
npm run desktop:make        # on a Mac
```

You also need a **Developer ID Application** certificate in the login keychain.
Forge signs the .app and then notarises it with Apple; the first notarisation
of a build takes a few minutes.

Hardened runtime entitlements are not required by anything Framevo does
(no JIT beyond Chromium's own, no unsigned executable memory), but the render
subprocess is a re-launch of the app's own binary, so if you add
`com.apple.security.cs.disable-library-validation`, do it deliberately.

## What you must supply

These are genuine external requirements — they cannot be produced from this
repository:

| Need                          | Why                                                  |
| ----------------------------- | ---------------------------------------------------- |
| Windows OV/EV certificate     | signed installer, no SmartScreen warning             |
| Apple Developer ID + team ID  | macOS distribution outside the App Store             |
| App-specific Apple password   | notarisation                                         |

Never commit any of these. They are read from the environment at package time
and are never written into the app.
