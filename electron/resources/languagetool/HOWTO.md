# LanguageTool (optional grammar/punctuation server)

Bethaniel can run grammar and punctuation checks through a **local, offline**
LanguageTool HTTP server. This is optional: if the distribution below is
missing, the backend silently skips grammar checks (the "Grammar & punctuation"
toggle becomes a no-op) and nothing else is affected.

**Only this `HOWTO.md` is committed** — the LanguageTool distribution itself is
git-ignored (it's ~500 MB) and dropped in per machine / bundled at build time.

## Enabling it

Unzip a LanguageTool **stand-alone / server** distribution into this directory
so the layout is (top-level `LanguageTool-x.y/` folder flattened away):

```
electron/resources/languagetool/
  languagetool-server.jar        ← required (class org.languagetool.server.HTTPServer)
  libs/ … org/ … META-INF/       ← the rest of the distribution (needed at runtime)
  jre/bin/java[.exe]             ← optional bundled JRE (else system `java`)
```

Download from https://languagetool.org/download/ (LGPL). Flatten the archive's
top-level folder so `languagetool-server.jar` sits directly in this directory
next to `libs/`.

## How it's wired

- Packaging: `electron-builder.yml` copies this directory to
  `resources/languagetool/` in the built app.
- Runtime: `electron/main.ts` detects the jar/JRE and sets `LANGUAGETOOL_JAR`
  and `JAVA_BIN` for the backend.
- Backend: `backend/src/languageToolServer.ts` spawns the server on demand and
  `backend/src/languageTool.ts` queries `/v2/check`. Both degrade to no-ops if
  the jar or Java can't be found.

## Env overrides (dev / advanced)

- `LANGUAGETOOL_JAR` — absolute path to `languagetool-server.jar`.
- `JAVA_BIN` — absolute path to a `java` binary.
- `LANGUAGETOOL_PORT` — port for the local server (default 8081).
- `LANGUAGETOOL_BASE_URL` — point at an already-running server and skip spawning.
- `LANGUAGETOOL_DISABLED=1` — force grammar checks off globally, even if bundled.
