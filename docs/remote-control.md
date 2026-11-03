# Driving Noto from outside it

Noto can be driven by a program on the same machine: a script, a shortcut, or
an agent working alongside you. It is off until you switch it on, in
Preferences under Remote, and while it is on the status line says so.

## What it is, and what it is not

It listens on `127.0.0.1` and on no other interface, so nothing beyond this
machine can reach it. Every request carries a token, which is written to
`remote-token` beside the settings, readable by your account alone. A request
that carries an `Origin` header is refused, and so is one whose `Host` header
names anything but the loopback address: together those are what stop a page
in a browser, or a site whose name has been pointed at `127.0.0.1`, from
driving your editor.

What it can do is deliberately short. It cannot write to a path of its own
choosing, and it cannot run whatever the menus happen to carry. Opening a note
goes through the same check every other path in the app goes through, which
confines it to the folder that is open.

## Finding it

While it is listening, `remote.json` sits beside the token and says where:

```sh
DIR=~/Library/Application\ Support/Noto
PORT=$(python3 -c "import json;print(json.load(open('$DIR/remote.json'))['port'])")
TOKEN=$(cat "$DIR/remote-token")
BASE=http://127.0.0.1:$PORT
```

Both files are readable by your account alone, and both go when it stops, so
a stale one never points at a port with nothing on it.

It listens on port 37610. A second copy of the app, a development build
beside the one in daily use, can set `NOTO_REMOTE_PORT` to another port from
1024 up, or it finds that port taken and does not listen at all.

## The requests

Every reply is JSON. The token goes in the `Authorization` header. A refusal
carries a `code` as well as a sentence, so a program never has to match on
English: `unauthorized`, `browser`, `host`, `no-route`, `bad-body`,
`bad-path`, `no-such-note`, `outside-folder`, `open-failed`, `bad-text`,
`bad-place`, `unknown-command`, `no-document`, `no-window`, `bad-query`,
`bad-pattern`, `too-large`.

| Request | Method | Body | What it does |
| --- | --- | --- | --- |
| `/v1/status` | GET | | The protocol version, the app's version, the folder, the note in front, and whether it has unsaved changes |
| `/v1/commands` | GET | | What it accepts: the commands, the routes, and where text may be inserted |
| `/v1/document` | GET | | The note in front, with `source` saying whether it came from the editor or the file |
| `/v1/open` | POST | `{"path": "..."}` | Opens that note. The path may be absolute or relative to the folder |
| `/v1/insert` | POST | `{"text": "...", "at": "caret"}` | Puts the text in. `caret` is where you are; `end` adds it as blocks after the last one |
| `/v1/command` | POST | `{"command": "save"}` | Runs one of the commands below |
| `/v1/search` | POST | `{"query": "...", "caseSensitive": false, "wholeWord": false, "regex": false}` | Searches the vault, as the rail's search does |
| `/v1/debug/state` | GET | | The notes open and which is in front, the ceiling on open notes, the renderer's error and warning counts, the last failed operations with their reasons, and where the log is |
| `/v1/debug/log` | GET | `?lines=100&event=workspace_` | The log's last events, newest last, optionally only those whose name starts with `event`. `lines` is 1 to 1000 |
| `/v1/debug/console` | GET | `?lines=100` | The window's last console lines, text and all, held in memory and gone when the app quits. `lines` is 1 to 300 |

The commands are `save`, `save-as`, `find`, `search-content`, `quick-open`,
`source-code-mode`, `toggle-sidebar`, `toggle-outline`, `toggle-read-only`,
`reload-from-disk`, `new-file` and `shortcuts`.

`/v1/document` answers with the editor's own copy when a window is there, so
unsaved changes are included, and `source` says `editor`. The text is what the
file would hold if it were saved at that moment, the same line endings and the
same last line, so comparing it against the file is meaningful. When no window
answers in time it falls back to the file and says `disk`.

## Debugging with it

The log on disk, `evidence/main.ndjson` beside the settings, records what
happened without the words of a note: a console line is kept there only as its
size and a hash. When something misbehaves, the debug routes say the rest
without anyone opening a file. A note that will not open, for instance:

```sh
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/debug/state" | jq '.documents, .recentFailures'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/debug/log?event=workspace_&lines=40" | jq -c '.entries[]'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/v1/debug/console?lines=50" | jq -r '.entries[] | "\(.level) \(.source):\(.line) \(.message)"'
```

A failed operation is logged with its reason, opening and closing a note log
how many are open, and the log moves to `main.1.ndjson` past 4 MB, so the
newest events and the stretch before them are always there.

## An example

Ask what is open, read it, add a paragraph at the end, and save:

```sh
auth="Authorization: Bearer $TOKEN"
json='content-type: application/json'

curl -s -H "$auth" $BASE/v1/status
curl -s -H "$auth" $BASE/v1/document | jq -r .markdown
curl -s -H "$auth" -H "$json" -d '{"text":"Added by a script.","at":"end"}' $BASE/v1/insert
curl -s -H "$auth" -H "$json" -d '{"command":"save"}' $BASE/v1/command
```

Find the notes that mention something, then open the first:

```sh
curl -s -H "$auth" -H "$json" -d '{"query":"kestrel"}' $BASE/v1/search |
  jq -r '.matches[0].relativePath' |
  xargs -I{} curl -s -H "$auth" -H "$json" -d "{\"path\":\"{}\"}" $BASE/v1/open
```

## If something goes wrong

A port already in use is reported in the pane rather than passed over in
silence; nothing is listening in that case. A token that has been somewhere it
should not have been is replaced with the button in the pane, which stops
everything holding the old one at once.
