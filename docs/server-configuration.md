# Server Configuration

## Command and Arguments

The server argument is a command string, split on whitespace. Anything after `--` is appended to the server's arguments:

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts -- --log-level 4
```

## Initialization Options

Pass LSP `initializationOptions` as a JSON file. See [`examples/init-options.json`](../examples/init-options.json) for a sample.

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts \
  --init-options-file ./init-options.json
```

## Client Capabilities

Add or override client capabilities with a JSON file. It's deep merged over the defaults lsbench sends: objects merge recursively, arrays and scalars replace. For example, to turn off completion snippets:

```bash
lsbench "typescript-language-server --stdio" -w ./project -s ./actions.ts \
  --client-capabilities-file ./client-capabilities.json
```

```json
{ "textDocument": { "completion": { "completionItem": { "snippetSupport": false } } } }
```

## Settings

Give the server client settings with a JSON file keyed by section, like VS Code's `settings.json`:

```bash
lsbench "vscode-html-language-server --stdio" -w ./project -s ./actions.ts \
  --settings-file ./settings.json
```

```json
{
  "js/ts": { "implicitProjectConfig": { "checkJs": true } },
  "html.format": { "enable": true }
}
```

**Expansion**: like VS Code, lsbench expands dotted keys into nested objects at every level, so the example becomes `{ "js/ts": { ... }, "html": { "format": { "enable": true } } }`.

- Keys that meet at the same path deep merge. On a conflict, a key without dots wins over a dotted one.
- Language override sections, top level keys such as `[yaml]` or `[javascript][typescript]`, keep their keys flat as in VS Code. `{ "[yaml]": { "editor.tabSize": 2 } }` stays as is, and `{ "[yaml].editor.tabSize": 2 }` becomes the same.

**`workspace/configuration`**: each item's `section` is resolved as a dotted path into the expanded settings.

| Section | Result |
| --- | --- |
| `html` | `{ "format": { "enable": true } }` |
| `html.format.enable` | `true` |
| `[yaml]` | `{ "editor.tabSize": 2 }` |
| unknown | `null` |
| none | the whole settings object |

**`workspace/didChangeConfiguration`**: after `initialized`, the expanded settings are sent once as `{ settings }`, and again after each restart.

Without a settings file, every item gets `{}` and no `didChangeConfiguration` is sent.

**Only the keys in the file are sent.** VS Code sends every setting with its default, so a server written against VS Code may read a missing key as `false`. For example, vscode-json-language-server turns schema validation off unless `json.validate.enable` is `true`, so a settings file with only `"json.format.enable": true` disables validation and diagnostics waits time out. List every setting the server needs. Verbose mode logs the settings sent, so a missing key is easy to spot.

## From Code

For full control, drive `LspHarness` programmatically with a `ServerConfig`. It takes `command`, `args`, `env`, `initializationOptions`, `clientCapabilities`, `settings`, `allowExitCodes`, `allowExitSignals` and `allowUnrepliedShutdown`.

- `resolveServerConfig(command, options?)` builds one from a `--server` style command string. `options` (`ServerConfigOptions`) takes the matching `BenchOptions` fields, such as `serverArgs` and `allowExitCodes`, so a `BenchOptions` object can be passed as is.
- `defaultClientCapabilities()` and `mergeCapabilities()` build on the defaults.
- `expandSettings()` shows how settings are expanded.
