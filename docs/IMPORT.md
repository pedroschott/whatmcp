# File import

Use the CLI to build an archive from a compatible `ChatStorage.sqlite` file on
Windows or macOS. Run commands from the WhatMCP checkout after `npm install`.
Use Node.js 22.6 or newer.

## Prepare the source

The source must be a readable, decrypted SQLite database with the schema expected
by [the source reader](../src/whatsapp/source.ts). The reader queries
`ZWAMESSAGE`, `ZWACHATSESSION`, `ZWAGROUPMEMBER`, and `ZWAPROFILEPUSHNAME`,
including their message, relationship, and contact columns. Table names alone
do not establish compatibility.

A database extracted from an iOS backup can be used if its schema matches. Extract
and decrypt it before import. WhatMCP does not extract device backups, decrypt
files, or parse chat exports. It has no adapter for the Windows WhatsApp app or
Android message databases.

For an encrypted Finder backup, follow [Import iPhone history](IPHONE.md).

Use a consistent database copy. Keep any associated `-wal` and `-shm` files next
to it under their original names. The reader copies these files with the database
before extraction. Do not discard WAL data: it can contain committed messages.

## Select the source

Set `WHATMCP_CHATSTORAGE` to the absolute path of the prepared source file. The
examples below use placeholder paths. Replace them with the path on your computer.
Choose one shell.

**Windows Command Prompt:**

```bat
set "WHATMCP_CHATSTORAGE=C:\WhatsAppData\ChatStorage.sqlite"
npm run index -- --full
```

**Windows PowerShell:**

```powershell
$env:WHATMCP_CHATSTORAGE = 'C:\WhatsAppData\ChatStorage.sqlite'
npm run index -- --full
```

**macOS shell:**

```sh
export WHATMCP_CHATSTORAGE="/absolute/path/to/ChatStorage.sqlite"
npm run index -- --full
```

The index command reads the source and writes to the WhatMCP archive. It does not
call the embedding API. `--full` scans all source rows. Existing messages remain
in the archive; matching IDs can have their text and type updated.

Environment variables in these examples last for the current shell session.
To keep the source path across sessions and MCP clients, set `chatstorage` in
the WhatMCP `config.json` file. Preserve any existing settings. Use escaped
backslashes or forward slashes for Windows paths in JSON.

## Embed and search

Run these commands one at a time. Stop if a command fails.

```sh
npm run wa -- set-key
npm run embed
npm run wa -- search "a topic from your messages"
```

`set-key` prompts for the API key without showing it and saves it in the config
file. Skip this step if a key is already configured. Embedding sends conversation
text to OpenAI and incurs API charges. Semantic search sends the search query.

Keyword search does not need an API key or embeddings:

```sh
npm run wa -- search "a word from your messages" --mode=bm25
npm run wa -- chats
```

The guided `setup` and parts of `doctor` check macOS paths and services. Do not
use their macOS installation checks to assess a Windows file import. Check the
index output, list chats, and search the archive. The MCP `get_archive_status`
tool reports counts and embedding coverage; source freshness is based on the
configured file, not on the phone.

## Data and configuration paths

By default, WhatMCP stores its config and archive in `.whatmcp` under the Node.js
user home directory: normally `%USERPROFILE%\.whatmcp` on Windows and
`~/.whatmcp` on macOS.

| Environment variable | Purpose |
|---|---|
| `WHATMCP_CHATSTORAGE` | Source database to read during indexing |
| `WHATMCP_STORE` | Destination archive, or existing archive to search |
| `WHATMCP_HOME` | Directory for config and the default archive |

`chatstorage` and `store` in `config.json` provide persistent path settings.
Environment values take precedence. Use the same archive settings for CLI and
MCP processes. A source database and a WhatMCP archive have different schemas;
do not use the same file for both paths.

## Use an existing archive

To search or serve an existing WhatMCP `archive.db`, set `WHATMCP_STORE` to its
absolute path. In Command Prompt:

```bat
set "WHATMCP_STORE=C:\WhatsAppData\archive.db"
npm run wa -- chats
```

Use `store` in `config.json` if an MCP client launches the server outside this
shell. The archive must have a schema version compatible with the code. Reading
an existing archive does not require the original source file; indexing and
syncing still require it. Semantic search also requires the configured embedding
model, its vectors, and an API key.

## Change sources

Back up the archive before merging another source. Pause any scheduled sync while
changing sources. Use `index --full` each time you switch databases: the saved
source-row cursor is shared, but different databases can use different row IDs.

To return to the default macOS Desktop source, clear `WHATMCP_CHATSTORAGE` from
the shell and remove a custom `chatstorage` config value if one is set. Then run:

```sh
unset WHATMCP_CHATSTORAGE
npm run index -- --full
```

On Windows, set the next compatible source path explicitly and run the same full
index command. The default source path points to the macOS WhatsApp container.

A file import does not receive new phone messages automatically. Supply an
updated source file and index it again. `sync` combines indexing and embedding;
it still reads the configured source. The `sync-every` command and scripts under
`deploy/` use macOS services.
