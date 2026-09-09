# request-logger

A small proxy with no dependencies. It sits between your coding agent and the
model provider's API, and writes a **readable Markdown document for every
request**: the real system prompt, the tool definitions, and the messages your
agent sends to the model.

It was built for the AI Coding Crash Course so that you can _see_ what actually
goes over the wire.

## Run it

```bash
npm run request-logger
```

The first time you run it, it asks which agent you use, then which model
provider you use with it. (OMP is the one exception: it has no fixed provider
of its own, so it skips straight to the base URL question below.) Last, it
asks whether to remember your answer. Say no if you swap agents often, and it
asks again every time. It then prints the exact command for your setup, and
starts listening.

It keeps listening until you stop it. Press **Ctrl+C** to stop it. The console
says so too.

Both questions end with **Other, or not sure**. Pick it if your setup is not in
the list, and the tool gives you a link to ask for it.

The provider question has a second way out, too: **Custom base URL**. Pick it
if your provider is not in the list but you know its base URL — a local model
server such as Ollama, or a smaller hosted provider such as DeepSeek, say. It
asks two questions instead of showing you a dead end:

- the base URL of the model server you want to log, for example
  `http://localhost:11434` for Ollama, or `https://api.deepseek.com` for
  DeepSeek; and
- which wire format it speaks — OpenAI-compatible, Anthropic-compatible, or
  "not sure", if you do not know.

If you are not sure, pick "not sure". The tool still logs everything; it just
shows you the raw JSON instead of a fully readable render, because it cannot
safely guess a shape you did not tell it. See "What you get" below.

For **OpenCode** with an **OpenAI-compatible** custom target, and for **every**
**Pi** custom target, the wizard also tries the unauthenticated `/v1/models`
endpoint and offers any model IDs it finds. You can always enter an ID
manually, and the wizard falls back to manual entry if discovery fails.
Endpoints that require credentials for model listing are not supported.

- OpenCode's printed command uses a temporary `OPENCODE_CONFIG_CONTENT`
  provider for that one run, merged with your existing OpenCode configuration
  without editing its file.
- Pi has no such temporary option, so the selected model is written into
  `~/.pi/agent/models.json` alongside the base URL, replacing that provider's
  built-in model list with the one you chose. Without this, Pi would keep
  offering its built-in model names (`gpt-4o`, and the like), which almost
  never exist on a custom server — the agent would start but every turn would
  fail.
- Pi asks for a model on every wire format, including Anthropic-compatible —
  but discovery itself only ever checks the OpenAI-style `/v1/models` listing
  endpoint, which an Anthropic-compatible server often does not expose. If
  discovery finds nothing there, that is expected, and typing the model ID by
  hand is the normal path, not a sign something is broken.

To change a remembered answer:

```bash
npm run request-logger -- --force
```

This forgets the old answer first, then keeps the new one in its place. It does
not ask whether to remember, because you already said yes once. If you pick an
agent that cannot be logged, nothing is kept, and the old answer is gone too.

To use a different port:

```bash
PORT=9000 npm run request-logger
```

On Windows, run that in PowerShell (not Command Prompt) as:

```powershell
$env:PORT = 9000; npm run request-logger
```

A remembered answer is kept in `request-logger/.agent-choice.json`, which is
gitignored. It holds your choice only. The host, the renderer and the command are
worked out again on every start, so an update to this tool reaches you without
you having to clear anything.

The one exception is a **Custom base URL** answer. There is no catalogue entry
for it to be worked out from — you typed it — so the base URL and the wire
format you chose are saved in the file too, alongside your choice. OpenCode's
OpenAI-compatible custom route, and every Pi custom route, also save the
selected model ID, so a remembered choice starts without repeating discovery.
Everything else about a custom answer still behaves the same way: change it
any time with `--force`, and it is never kept for an agent that cannot be
logged.

## The agents

The tool prints the correct command for you, so you do not have to copy anything
from this table. It is here so you can see what is supported before you start.

| Agent           | Works | What you need                                                                            |
| --------------- | ----- | ---------------------------------------------------------------------------------------- |
| Claude Code     | Yes   | One command. Works with a subscription login, an Anthropic API key, or Google Vertex AI. |
| Codex           | Yes   | One flag. A subscription or an API key works.                                            |
| GitHub Copilot  | Yes   | Your normal subscription login.                                                          |
| OpenCode        | Yes   | One command, or a config file.                                                           |
| Pi              | Yes   | A config file. Pi has no base URL variable.                                              |
| OMP             | Yes   | A YAML config file. Point it at any backend.                                             |
| Gemini CLI      | Yes   | One command. The free Google login works.                                                |
| Antigravity CLI | Yes   | A config file and a real Gemini API key — see below.                                     |
| Junie           | Yes   | A config file, and a real API key pasted in — see below.                                 |
| Qoder           | Yes   | A BYOK custom provider, if your account has that feature — see below.                    |
| Cursor CLI      | No    | Nothing can make it work. See below.                                                     |
| Amp             | No    | Nothing can make it work. See below.                                                     |

Any other provider — a local model server, or a smaller hosted one — works
through **Custom base URL**, above, on any agent in this table except Cursor
and Amp.

### Claude Code on Google Vertex AI

If your Claude Code already talks to Vertex AI (`CLAUDE_CODE_USE_VERTEX=1` is
set), pick **Google Vertex AI** at the provider question instead of
**Anthropic**. Vertex mode reads a different variable for a base-URL
override — `ANTHROPIC_VERTEX_BASE_URL`, not `ANTHROPIC_BASE_URL` — because
`ANTHROPIC_BASE_URL` belongs to the direct-API code path and is silently
ignored once Vertex mode is on. Picking **Anthropic** here while
`CLAUDE_CODE_USE_VERTEX=1` is set is the most common way a Vertex student's
logs folder stays empty with no error at all.

This route only covers `CLOUD_ML_REGION=global`, the default and most common
setting. A regional value (`us-east5`, say) talks to a different host and
is not wired up yet — ask for it via the issue tracker if you hit this.

### Antigravity CLI

Antigravity CLI (`agy`) is a separate Google product from Gemini CLI — a
different binary, a different agent harness — not a rebrand of it. Its API-key
route, though, stores its settings under Gemini CLI's own directory
(`~/.gemini/antigravity-cli/settings.json`) and calls the public Gemini API
directly, reading the exact same `GOOGLE_GEMINI_BASE_URL` variable Gemini
CLI's own API-key route reads. That means the existing `gemini` renderer
already reads this capture correctly — no new wire format was needed, only a
catalogue entry.

Two things must both be true before Antigravity CLI takes this route at all,
rather than falling back to its own account sign-in:

- `modelProvider` is `"gemini"` in the settings file the wizard writes for you, and
- `GEMINI_API_KEY` is exported in your shell — this tool does not set it, the
  same way it does not set `ANTHROPIC_API_KEY` for Claude Code's own API-key
  route.

Only this API-key route is covered. Antigravity CLI's default account
sign-in was not verified — Antigravity CLI is closed source, and public
reporting on the related Antigravity IDE suggests its account-login traffic
can go to a different, internal host rather than the Code Assist host Gemini
CLI's own free login uses. Ask for it via the issue tracker if you need it
logged.

### Junie

Junie is BYOK across several backends, with no fixed host of its own — the
same shape as OMP — so it goes through the base URL and wire format
questions like a custom target does, picking a real Anthropic-compatible or
OpenAI-compatible template depending which you choose. It writes a proxy
entry to `~/.junie/config.json` (user scope; a project-scope file at
`<project-root>/.junie/config.json` takes precedence if you have one — see
Junie's own docs), merged in alongside whatever else is already there.

Junie is the one agent here with no existing login for this tool to pass
through. Its custom-proxy mechanism bypasses JetBrains AI authentication
entirely, so the printed config carries a placeholder header line and you
paste in a real API key yourself — an Anthropic key on the
Anthropic-compatible route, an OpenAI key on the OpenAI-compatible one.
Treat that file the way you would any other file holding a real key: do not
commit it.

### Qoder

Qoder CLI (`qodercli`) reaches models two unrelated ways, and this tool can
only log one of them.

The **BYOK route** is the one that works. There Qoder calls a base URL you give
it, in a standard wire format, with nothing in between — the same shape as
Junie and OMP, so no new renderer was needed. It goes through the base URL and
wire format questions the way a custom target does.

Unlike Junie, there is no config file for this tool to write. Qoder's own docs
tell you not to set BYOK up by hand in its settings file, so the base URL goes
into `qodercli`'s own wizard instead: run `/model`, choose **Custom**, and paste
what this tool printed. Which URL to paste depends on the protocol you pick
there, because Qoder joins the two differently for each one:

| Protocol           | Base URL to paste          | Qoder appends       |
| ------------------ | -------------------------- | ------------------- |
| `anthropic`        | `http://localhost:8787`    | `/v1/messages`      |
| `openai`           | `http://localhost:8787/v1` | `/chat/completions` |
| `openai-responses` | `http://localhost:8787/v1` | `/responses`        |

The banner's `Listening` line is the address the proxy binds, so it never
carries the `/v1`. The note printed underneath it spells out the URL to paste,
which is the one to copy.

The wizard asks for an API key and a model ID as well. Both have to be real ones
for whichever provider you are logging: this tool only stands between the two
and forwards what it is given.

BYOK sits behind a server-side feature gate Qoder calls `custom_providers`, and
Qoder's docs put the feature on the Individual plan. If `/model` shows no
**Custom** option, your account does not have it, and nothing you write into a
local config file will make it appear — the check runs against Qoder's servers
on every start.

#### Why Qoder's default route cannot be logged

The **default subscription route** — the one your Qoder login uses when you have
not set BYOK up — cannot be logged. The reason is worth understanding, because
it is not the reason the next section gives for Cursor and Amp.

It is not simply a missing base-URL override, though that part is true and it is
what makes the route impossible to _redirect_. Qoder elects its inference host at
runtime from its own region-endpoint service and resolves it through Aliyun's
HTTPDNS, and the `QODER_*_BASE_URL` names that look like overrides in the
shipped binary are compile-time constants, not environment variables — nothing
reads them at runtime.

It is not Cursor's and Amp's reason either, and this is the part that matters.
Qoder builds its system prompt and its tool schemas **on your machine**, and
really does send them. They go past your network card. What stops you reading
them is that Qoder passes the request body through an encoder in a WASM module
first, so what crosses the wire is not the JSON that was built.

This was checked against `qodercli` 1.1.47 by intercepting its TLS traffic — it
honours `HTTPS_PROXY`, and `NODE_EXTRA_CA_CERTS` adds a certificate to its trust
store for that one process without touching your system's. The interception
worked; the body did not become readable. The request arrived as 285 KB of
deterministic, high-entropy data over a 65-symbol printable alphabet, on a URL
marked `Encode=1`. That marker is deliberate and per-endpoint: the calls Qoder
makes without it, to its own config and codebase services, arrive as plain JSON.
The response to the encoded request, meanwhile, came back as plain
OpenAI-shaped JSON.

So a proxy can see this traffic and cannot read it. That is a limit of this
tool, not a property of Qoder's product — which is exactly how it differs from
Cursor and Amp, where no proxy could ever see it at all.

### Why Cursor and Amp cannot work

This is the most interesting thing in the whole lesson, so it is worth saying
clearly.

Some vendors build the system prompt **on your machine** and send it to the
model. You can read that, because it goes past your network card.

Some vendors build the system prompt **on their servers**. Your machine sends
your message and very little else. The prompt and the tool list are added after
your request arrives at their server.

Cursor and Amp are the second kind. Search the whole shipped Cursor bundle and
you will find no system prompt text and no tool schemas at all. No proxy can
read what your machine never sends. This is not a limit of this tool. It is a
property of the product.

There is a third kind, and it is worth not confusing it with the second. A
vendor can build the prompt on your machine, send it, and still leave you
unable to read it — by encoding the request body on the way out. Qoder's
default route does exactly that; see [Qoder](#qoder) above. The distinction is
not academic. The second kind is a permanent fact about the product, and no
tool will ever read it. The third kind is a gap in this one, and a tool that
could undo the encoding would read it fine.

If you use Cursor or Amp, install one of the other agents to follow the lesson.

## The Observer Effect

Watching a thing can change the thing.

Claude Code trusts exactly one host. When you point it somewhere else, it turns
off tool search. That means it stops deferring tools and writes every tool
schema into the request instead. Your capture is then bigger than a real one and
has a different shape. That is the opposite of what you want from a tool whose
whole job is to show you the truth.

The command this tool prints for you sets `ENABLE_TOOL_SEARCH=true`, which turns
the effect off.

Measured through this tool with the same prompt:

| Run                            | Capture size |
| ------------------------------ | ------------ |
| Base URL only                  | 63,596 bytes |
| With `ENABLE_TOOL_SEARCH=true` | 39,013 bytes |

That is 39% smaller, and the tool-search tool appears only in the second
capture.

## What you get

Every request writes three files to `request-logger/logs/`, which is gitignored.
They share a base name such as `2026-07-07T14-32-05-123_claude-code`:

| File            | Contents                                 |
| --------------- | ---------------------------------------- |
| `.md`           | The readable render. Start here.         |
| `.request.txt`  | The request body exactly as it was sent. |
| `.response.txt` | The raw response stream.                 |

The `.md` file uses **XML tags** (`<request>`, `<system-prompt>`, `<tools>`,
`<messages>`, `<response>`) to mark its sections, because the captured content is
full of its own Markdown headings. It is complete and not truncated, so it is a
trustworthy readout of what the model received.

If you picked "not sure" for a custom base URL's wire format, the `.md` file
holds pretty-printed JSON instead of that fully tagged render — there is no
system prompt or tool section, because the tool was not told the shape needed
to find them. Nothing is lost: it is still the whole request and response, just
less readable. Run with `--force` and pick the real wire format once you know
it, and the tagged render takes over from the next request.

Secret headers (`authorization`, `x-api-key`, `api-key`) are hidden in the `.md`
file and are never written to the `.txt` files.

Some agents compress the request body. The `.md` file shows the decoded body so
that you can read it. The `.request.txt` file keeps the bytes exactly as they
were sent, so you can still replay it.

## How it works

- One process, one port, **one upstream host**. Your choice decides where
  requests go and how they are read. The tool does not guess from the URL,
  because several agents share the same URLs and guessing gets them wrong.
- Your real auth header passes through untouched, so your requests authenticate
  normally. The tool only reads a copy on the way past.
- Responses are **streamed straight back** as they arrive, so your agent behaves
  exactly as it would without the tool.

### One message is not one request

A single message you send is often **not** a single API request. A typical
Claude Code turn fans out into:

- **one** real generation call, which is the only one that produces a reply, and
  the one whose request holds the full system prompt and tools; and
- **many** token-counting calls, which are housekeeping. They measure sizes for
  the context bar, for caching and for compaction, and they return a number
  rather than model output.

Housekeeping calls carry no model output, so the tool **forwards them but does
not log them**. Your logs folder therefore holds real turns only. You still see a
`(housekeeping, not logged)` line in the console when they happen, so the fan-out
stays visible.

Different agents fan out differently, and that is worth watching:

- **OpenCode** never counts tokens. Instead it makes a second call with a small
  model to title the thread, so one turn writes exactly two captures.
- **Pi** never counts tokens at all, so every file is a real turn.
- **Gemini** on the free Google login makes several extra calls that carry no
  prompt. Those are not logged either.

### If your logs folder fills up in seconds

Some agents retry a failing call immediately and with no backoff. If the
call keeps failing the same way — a wrong base URL scheme, a bad model ID,
bad credentials — that turns into a tight loop of real requests, each one a
genuine POST the tool would otherwise write a full capture for. Left
unchecked, that is thousands of near-identical files in a few seconds.

Once the same method, path and status code repeats more than 20 times inside
2 seconds, this tool stops writing a capture for every repeat. It still
forwards every one of them untouched, so your agent is not affected; it just
stops filling your disk and your terminal with duplicates. You get one loud
warning naming the call and the likely causes, then a single summary line
every 500 repeats for as long as the loop continues.

The fix is always upstream of this tool: stop the agent, fix the base URL,
model ID or credentials, and start again. `omp` hitting `http://` instead of
`https://` on a provider's real API is the case this was built for — the
plaintext request gets rejected in milliseconds with no retry guidance in the
response, and some agents read that as "retry", not "give up."

## If your logs folder stays empty

The failure modes here are quiet ones. An empty folder looks the same whichever
of these happened:

1. **You changed agent and forgot to say so.** Run
   `npm run request-logger -- --force`. The line at the top of the console names
   the agent the tool currently thinks you use.
2. **Your agent chose a WebSocket.** This tool reads HTTP. Some Copilot models,
   and Pi's default transport, negotiate a WebSocket instead, and a WebSocket
   turn writes no log at all. The printed command sets the right transport where
   it can.
3. **You are signed in a way that goes around the tool.** A ChatGPT sign-in on
   OpenCode talks to a different host on purpose. Use an API key for that one.
   Codex is different: pick the ChatGPT route in the wizard and it works.
4. **You started your agent before setting the variable.** Agents read the
   variable once, at startup.
5. **You are on an older Codex, or following an older guide.** Codex used to
   read an OPENAI_BASE_URL variable. Version 0.133.0 does not. It ignores the
   variable in silence, so the only sign is an empty logs folder. Use the
   command this tool prints.

## How much this was tested

Be fair to the tool when you judge a failure.

- **Claude Code on the direct Anthropic API, and OMP, are tested end to end.**
  The measurements above are real, and OMP is run daily by the person who
  built this tool.
- **The others were verified** by reading the published code of each agent and
  by driving them against a local listener. They were not each run through a
  full course of the lesson. Claude Code on Google Vertex AI is in this
  group — verified against Anthropic's own Vertex documentation, not yet
  driven against a real Vertex project.
- **Junie is the least-verified entry in the catalogue.** Junie CLI is
  closed source, so unlike every other agent here its entry was not checked
  against real source, only against JetBrains' published Junie CLI docs
  (`config.json`, custom proxies, and CLI reference). It has not been driven
  against a real Junie install. If the proxy `kind`, the config file's
  precise shape, or the header format is wrong, that is the likely reason,
  and the fix is one line in `agents.ts`.
- **Antigravity CLI is verified against published docs only, the same way
  Junie is.** Antigravity CLI is also closed source. Its API-key route was
  checked against Google's own Antigravity CLI documentation (installation,
  authentication and the `GOOGLE_GEMINI_BASE_URL` variable), not against real
  source or a real install, and its account sign-in route was not verified
  at all — see "Antigravity CLI" above for why that route is left out.
- **Qoder is verified against the real binary, but its BYOK route was never
  driven end to end.** `qodercli` is closed source and ships as compiled
  bytecode, so its entry was checked against the strings the binary itself
  carries — the BYOK config schema it validates, and the three path constants
  it appends to a base URL — plus a real TLS interception of its traffic,
  which is where the "Why Qoder's default route cannot be logged" section
  above gets its evidence from. The BYOK route could not be driven: the
  account this was researched on has the `custom_providers` gate switched off,
  so `/model` shows no Custom option to paste a base URL into. What is tested
  is the wizard's output for it and the resolution behind that output.
- **A custom base URL is only as tested as the agent it is attached to.** The
  base URL and wire format mechanism itself is tested directly (see
  `agents.test.ts`); a specific third-party server behind it has not
  necessarily been driven end to end.
- **Windows is not tested end to end either.** WSL and Git Bash need no
  special handling — they are POSIX shells, so they use the same command as
  Mac and Linux. Native PowerShell gets its own `$env:NAME = 'value'` syntax
  instead (see `withEnv` in `agents.ts`), verified by unit test but not by
  running a real agent against it on Windows. Command Prompt (`cmd.exe`) is
  not supported; use PowerShell, which is the default terminal in Windows
  Terminal and VS Code.

If one of them is wrong, it is worth reporting, and the fix is likely to be one
line in `agents.ts`.

## Extending it

- **Add an agent:** add one entry to the catalogue in `agents.ts`, giving its
  upstream host, its renderer, its base URL suffix, and its command. That is the
  whole job. The wizard, the banner and the routing all read from there, so
  nothing else needs to change.
- **Add an agent with no fixed upstream at all**, the way OMP has none: give it
  no upstream host, set `alwaysCustom: true`, and give its one provider entry a
  bin and a setup file. The wizard then skips the provider question for it
  entirely and asks the two custom-base-url questions directly. See the OMP
  entry in `agents.ts` for the whole shape. If the agent takes its base URL by
  hand instead of from a file or a variable, the way Qoder's does, then nothing
  carries the suffix — the banner's `Listening` line does not — so put
  `{baseUrl}` in the note text, which is filled in exactly as a setup file body
  is.
- **Add a wire format:** add a renderer in `render.ts` and name it on the
  catalogue entry. Unknown shapes already fall back to pretty-printed JSON, so
  you can iterate safely.
- **Watch the base URL suffix.** It is per-agent on purpose and never a global
  rule. Some agents append the whole path to what you give them and so must not
  have a `/v1`. Some append only the last part and so must have one. Getting it
  wrong produces a 404 that is hard to read. There is a test for each one.
- **Nothing to do for a student on an unlisted provider.** "Custom base URL" at
  the provider question already covers that — see the top of this README. It
  is not a per-agent thing to add; every supported agent gets it for free.
