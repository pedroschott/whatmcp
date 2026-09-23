# Import iPhone history

An iPhone backup can contain older messages that are absent from the macOS
WhatsApp Desktop database. Import the extracted database to add those messages
to the WhatMCP archive. The available history depends on the backup; this process
does not recover messages that are absent from it.

The extraction steps below use Finder and a macOS shell. The prepared SQLite file
can then be imported on Windows or macOS with the [file import commands](IMPORT.md).
The workflow is documented in [issue #2](https://github.com/pedroschott/whatmcp/issues/2).

## 1. Finish the device backup

In Finder, select the iPhone and create an encrypted local backup. Keep the phone
connected until Finder reports completion. Keep the backup password; extraction
requires it.

Open the device folder under:

```text
~/Library/Application Support/MobileSync/Backup/
```

From that folder, check the metadata:

```sh
plutil -p Status.plist
plutil -extract IsEncrypted raw -o - Manifest.plist
ls -lh Manifest.plist Manifest.db
```

For this workflow, `SnapshotState` must be `finished`, `IsEncrypted` must be
`true`, and both manifest files must exist. An `uploading` state is not a completed
snapshot. These checks do not prove that WhatsApp data is present; the next step
checks the manifest for it.

## 2. Extract the WhatsApp database

Use Python 3.8 or newer and
[`iphone_backup_decrypt`](https://github.com/jsharkey13/iphone_backup_decrypt).
This is a separate extraction tool, not a WhatMCP dependency.

```sh
mkdir -p "$HOME/Documents/whatsapp-extract"
cd "$HOME/Documents/whatsapp-extract"
python3 -m venv .venv
source .venv/bin/activate
python -m pip install iphone_backup_decrypt
```

Save the following script as `extract.py`. Run it with `python extract.py`. Enter
the full device backup folder path, then enter the Finder backup password. The password is not shown or saved in
shell history. The script writes to a new directory and leaves the backup intact.

```python
from getpass import getpass
from pathlib import Path
import os
import tempfile
from iphone_backup_decrypt import EncryptedBackup

os.umask(0o077)
source = Path(input("Device backup folder: ")).expanduser().resolve()
backup = EncryptedBackup(
    backup_directory=str(source),
    passphrase=getpass("Finder backup password: "),
)
print("Decrypting the manifest...", flush=True)
with backup.manifest_db_cursor() as cur:
    cur.execute("""
        SELECT domain, relativePath FROM Files
        WHERE domain = ? AND flags = 1
          AND relativePath IN (?, ?, ?, ?)
    """, (
        'AppDomainGroup-group.net.whatsapp.WhatsApp.shared',
        'ChatStorage.sqlite', 'ChatStorage.sqlite-wal',
        'ChatStorage.sqlite-shm', 'ChatStorage.sqlite-journal',
    ))
    rows = cur.fetchall()
if not any(path == 'ChatStorage.sqlite' for _, path in rows):
    raise SystemExit("WhatsApp ChatStorage.sqlite is not listed in this backup.")
output = Path(tempfile.mkdtemp(prefix="extracted-", dir=Path.cwd()))
for domain, path in rows:
    target = output / path
    backup.extract_file(
        relative_path=path, domain_like=domain, output_filename=str(target)
    )
    print("Extracted:", target)
```

If the database is absent, stop and check the backup contents. WhatMCP cannot
index a file that the backup does not contain. The decryptor can report that the
decrypted size differs from the size in the manifest. Validate the database
before deciding whether it is usable.

## 3. Validate and prepare a standalone database

Use a static extracted copy, not a live database. The script below reads the
database, checks its integrity, reports message dates, and creates a new SQLite
file for WhatMCP. It does not print message text or overwrite an existing output.

For an extraction with no WAL or rollback journal data,
[SQLite's `immutable=1` option](https://www.sqlite.org/uri.html) avoids
journal-opening errors. Do not use that option to bypass a nonempty WAL or journal.
When either exists, the script uses a normal read-only connection. If that read
fails, stop and resolve the database or journal error; do not delete the journal.

Save the following script as `prepare.py`. Run it with `python prepare.py` and
enter the extracted database path.

```python
from pathlib import Path
import os
import sqlite3

os.umask(0o077)
source = Path(input("Extracted ChatStorage.sqlite path: ")).expanduser().resolve()
target = source.with_name("ChatStorage-standalone.sqlite")
if not source.is_file():
    raise SystemExit("Source file not found.")
if target.exists():
    raise SystemExit(f"Output already exists: {target}")
has_journal_data = any(
    p.exists() and p.stat().st_size > 0
    for p in (Path(str(source) + '-wal'), Path(str(source) + '-journal'))
)
uri = source.as_uri() + '?mode=ro'
if not has_journal_data:
    uri += '&immutable=1'
src = sqlite3.connect(uri, uri=True)
try:
    result = src.execute('PRAGMA quick_check').fetchall()
    if result != [('ok',)]:
        raise SystemExit(f"Integrity check failed: {result}")
    print("Integrity: ok")
    print("Messages, oldest UTC, newest UTC:")
    print(src.execute("""
        SELECT COUNT(*),
               datetime(MIN(ZMESSAGEDATE) + 978307200, 'unixepoch'),
               datetime(MAX(ZMESSAGEDATE) + 978307200, 'unixepoch')
        FROM ZWAMESSAGE
    """).fetchone())
    dst = sqlite3.connect(str(target))
    try:
        src.backup(dst)
        dst.execute('PRAGMA journal_mode=DELETE')
    finally:
        dst.close()
finally:
    src.close()
target.chmod(0o600)
print("Prepared:", target)
```

A successful integrity check does not establish full schema compatibility. The
indexer still needs the tables and columns listed in [File import](IMPORT.md).

## 4. Merge the history

Back up the existing WhatMCP archive and pause scheduled sync. Run the next
command from the WhatMCP checkout. Replace the source path with the prepared
file path printed above. For Windows syntax, use [Select the source](IMPORT.md#select-the-source).

```sh
WHATMCP_CHATSTORAGE="/absolute/path/to/ChatStorage-standalone.sqlite" \
  npm run index -- --full
```

The environment override above applies only to that command. Existing archived
messages are retained. Matching message IDs can have their text and type updated.
Messages with different chat or message identifiers may not deduplicate.

If routine sync uses the macOS Desktop database, run a full pass against that
source before resuming scheduled sync:

```sh
npm run index -- --full
```

This assumes the normal config points to the Desktop database and no source
override is exported in the shell. Otherwise, select the normal source explicitly.
The pass restores the source-row cursor for that database and keeps the imported
history. See [Change sources](IMPORT.md#change-sources).

On Windows, keep the prepared file as the source or select another compatible
file. Do not run a pass against the default macOS path.

## 5. Embed the new windows

With an API key configured, run:

```sh
npm run embed
```

Embedding sends conversation text to OpenAI and incurs API charges. Completed
batches are saved, so another run can resume the remaining work. Check embedding
coverage with the MCP `get_archive_status` tool.

Large histories can expose oversized inputs. If the API rejects an input for
exceeding its token limit, the import remains in the archive, but semantic
coverage is incomplete. See [issue #3](https://github.com/pedroschott/whatmcp/issues/3).
Do not treat successful indexing as proof that all windows have embeddings.
