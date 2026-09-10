/**
 * agents.ts — the catalogue of coding agents the request-logger can proxy.
 *
 * This module is the single source of truth for every per-agent fact:
 *  - which upstream host that agent's traffic must go to,
 *  - which renderer reads that wire format,
 *  - the exact command to run, correct by construction.
 *
 * Nothing else in the tool decides these things. The wizard reads the catalogue
 * to build its questions, the proxy reads the resolved target to route and to
 * render, and the startup banner prints the resolved command. Because the facts
 * are data rather than prose, they can be tested — and they cannot silently rot
 * the way a README does.
 *
 * Adding an eighth agent should be one entry here and nothing else.
 *
 * Not every student's setup fits a catalogue entry, though — a local model
 * server or a small provider has no fixed host to hard-code. For those, the
 * wizard offers "Custom base URL" wherever it offers a provider, and builds a
 * CustomTarget from what the student types instead of looking one up. See
 * resolveCustomTarget below.
 */

// The one fact this catalogue cannot state for itself: where certs.ts writes
// the CA that MITM mode needs, which the printed command has to name. Path
// arithmetic only — importing this touches no disk. See placeholderValues.
import { CA_CERT_PATH } from "./certs";

export type RendererId = "anthropic" | "openai" | "gemini" | "qoder" | "raw";

/**
 * What the student picked. This, and only this, is what gets saved to disk —
 * except the custom target fields, which are the one documented exception.
 * See config.ts.
 */
export interface AgentChoice {
  agent: string;
  provider?: string;
  /** Only set when provider is CUSTOM_ID: the base URL the student typed. */
  customBaseUrl?: string;
  /** Only set when provider is CUSTOM_ID: the wire format they chose for it. */
  customRenderer?: RendererId;
  /**
   * Selected model for a custom target that needs one declared up front:
   * OpenCode's custom OpenAI-compatible route, and any of Pi's custom
   * routes (see resolveCustomTarget).
   */
  customModel?: string;
}

export interface ResolvedTarget {
  kind: "target";
  agent: string;
  agentLabel: string;
  provider: string;
  providerLabel: string;
  /** The single host every request is forwarded to — unless `mitm` is set. */
  upstreamHost: string;
  renderer: RendererId;
  /** The base URL the student points their agent at, e.g. http://localhost:8787/v1 */
  baseUrl: string;
  /** The copy-pasteable command, complete with env vars and flags. */
  command: string;
  /** Config files the student must write before the command will work. */
  setup: SetupFile[];
  /** Things worth knowing. Printed under the command. */
  notes: string[];
  /** Things that will otherwise look like the tool is broken. */
  warnings: string[];
  /**
   * True when the agent is not pointed at this proxy by base URL but by
   * HTTPS_PROXY, so it sends CONNECT for whatever host it wants and the
   * upstream is only known once that connection opens.
   *
   * Qoder's subscription route is the one entry that needs this: it elects
   * its own host at runtime and offers no way to override it. mitm.ts
   * therefore clones this target per connection with the real host filled
   * in, which keeps `upstreamHost` honest for every later reader — handle,
   * writeCapture and the banner all still see one host per target.
   *
   * `baseUrl` is meaningless here and `upstreamHost` starts empty: nothing
   * connects to a URL, so neither is ever read as-is.
   */
  mitm?: boolean;
  /**
   * Which hosts a MITM run decrypts. A CONNECT for any other host is joined
   * straight to the host it named and passed through unread.
   *
   * Optional, and absent means "all of them": an agent whose inference host
   * cannot be predicted has to have every tunnel terminated, or nothing it
   * says is ever logged. Qoder's can at least be narrowed to a set of shapes,
   * and decrypting a tunnel that belongs to one of the TLS clients in qodercli
   * which ignores NODE_EXTRA_CA_CERTS only breaks that call — so it names the
   * hosts a model call can be on. See the subscription provider and mitm.ts.
   */
  mitmHosts?: RegExp;
}

/**
 * Resolved to a target the catalogue has no entry for: the student typed
 * their own base URL and picked their own wire format, rather than one being
 * looked up from a ProviderEntry. It plays the same role as a ResolvedTarget
 * everywhere downstream — the proxy routes to it and renders it exactly the
 * same way — so the two are only ever told apart by `kind`.
 */
export interface CustomTarget {
  kind: "custom-target";
  agent: string;
  agentLabel: string;
  /** Always "Custom base URL": there is no catalogue provider label to show. */
  providerLabel: string;
  /**
   * The scheme+host[+port] the student typed, plus any path prefix it
   * carried (e.g. https://opencode.ai/zen/go). proxy.ts joins that prefix
   * against each request's own path when forwarding — see
   * upstreamPathPrefix in proxy.ts.
   */
  upstreamBaseUrl: string;
  renderer: RendererId;
  baseUrl: string;
  command: string;
  setup: SetupFile[];
  notes: string[];
  warnings: string[];
}

export interface AgentRefusal {
  kind: "refusal";
  agent: string;
  agentLabel: string;
  reason: string;
}

export interface ResolveError {
  kind: "error";
  message: string;
}

/**
 * The student's setup is not in the catalogue, and they said so.
 *
 * This is not an error. The catalogue is a list of what has been tested, not a
 * list of what is possible, so the only useful answer is to ask for the missing
 * entry. It is never saved.
 */
export interface SetupRequest {
  kind: "request";
  /** The agent, when the student named one the catalogue knows. */
  agentLabel: string | null;
  /** Where to ask for the missing entry. */
  url: string;
}

export type Resolution =
  ResolvedTarget | CustomTarget | AgentRefusal | ResolveError | SetupRequest;

/**
 * Whether this target's upstream is discovered per TLS connection instead of
 * being fixed by the catalogue — the one thing proxy.ts has to know before it
 * can decide how to listen.
 *
 * A guard rather than a field read because a CustomTarget has no `mitm` field
 * at all, so `target.mitm` does not type-check against the union. It also
 * could not mean anything there: a custom base URL is a URL the student typed
 * and their agent calls directly, which is a plain reverse proxy by
 * definition. Only a catalogue entry can say its agent picks its own host.
 *
 * The narrowed type keeps `mitm: true` rather than widening to the whole
 * ResolvedTarget. A caller that tests this and then falls through to the
 * ordinary-target case needs the rest of ResolvedTarget to still be there in
 * that branch, and naming only the subset this proves leaves it there.
 */
export function isMitmTarget(
  target: Resolution
): target is ResolvedTarget & { mitm: true } {
  return target.kind === "target" && target.mitm === true;
}

/**
 * The last option in both questions.
 *
 * A student whose agent or provider is missing has nowhere to go otherwise.
 * They would either pick the nearest wrong thing and read a capture that is not
 * theirs, or quit. Both questions therefore end with this, and it leads to the
 * issue tracker.
 */
export const OTHER_ID = "other";
export const OTHER_LABEL = "Other, or not sure";
export const ISSUE_URL =
  "https://github.com/ai-hero-dev/ai-coding-crash-course/issues/new";

/**
 * The option next to "Other" at the provider question: a student whose
 * provider is not in the catalogue, but who knows its base URL, does not have
 * to file an issue and wait. This is offered on every supported agent's
 * provider question, however many catalogue providers it has — see
 * agentProviders and askChoice in config.ts.
 */
export const CUSTOM_ID = "custom";
export const CUSTOM_LABEL = "Custom base URL";

/**
 * The wire-format question a custom target answers instead of a renderer
 * being looked up from a ProviderEntry. "raw" is a real RendererId, not a
 * placeholder — render.ts checks it first and never guesses at a shape it
 * was not told.
 */
export const WIRE_FORMAT_OPTIONS: Array<{ id: RendererId; label: string }> = [
  { id: "openai", label: "OpenAI-compatible (chat/completions)" },
  { id: "anthropic", label: "Anthropic-compatible (messages)" },
  { id: "raw", label: "Not sure — show me the raw JSON" },
];

export interface SetupFile {
  path: string;
  body: string;
  language: string;
}

// ---------------------------------------------------------------------------
// Catalogue
// ---------------------------------------------------------------------------

interface ProviderEntry {
  id: string;
  label: string;
  upstreamHost: string;
  renderer: RendererId;
  /**
   * Appended to http://localhost:PORT to make the base URL.
   *
   * Per-agent, never global. OpenCode's SDK appends `/messages` to whatever it
   * is given, so it needs `/v1`. Aider's layer appends the whole path, so it
   * must not have one. Getting this wrong produces a 404 the student cannot
   * explain, so it is data, and it is tested.
   */
  suffix?: string;
  /** Environment variables, in the order they should appear in the command. */
  env?: Array<[string, string]>;
  bin: string;
  args?: string[];
  setup?: SetupFile[];
  /**
   * Prose printed under the banner. May carry `{baseUrl}`, filled in the same
   * way env values, args and setup file bodies are.
   *
   * An agent whose base URL arrives as an environment variable or inside a
   * setup file never needs this, because the command or the file already
   * carries the suffix. An agent with neither — Qoder, whose base URL goes
   * into its own `/model` wizard by hand — has no other way to say it, since
   * the banner's Listening line prints the address without the suffix.
   */
  notes?: string[];
  warnings?: string[];
  /**
   * Which custom-base-url wire formats this provider's command, env and
   * setup file are a reasonable stand-in for. Only consulted on an agent
   * with more than one provider — see findCustomTemplate. A provider tied to
   * one specific login route (a ChatGPT subscription, a Google account) is
   * never tagged: reusing its template for an unrelated third-party server
   * would silently misconfigure it rather than help.
   */
  customTemplateFor?: RendererId[];
  /**
   * True when this provider's traffic arrives as TLS CONNECT rather than as
   * requests to a base URL the student was given — the agent picks its own
   * upstream host and this tool has to sit in the middle to see anything at
   * all. Copied onto the ResolvedTarget; see ResolvedTarget.mitm and mitm.ts.
   *
   * Such a provider's `upstreamHost` is empty on purpose, and its `env` is
   * what makes it work: HTTPS_PROXY to route the agent here, plus the CA
   * certificate that lets it trust this proxy's freshly minted leaf.
   */
  mitm?: boolean;
  /**
   * Which hosts a MITM provider decrypts; a CONNECT for any other host is
   * joined straight to the host it named and passed through unread. Copied
   * onto the ResolvedTarget — see ResolvedTarget.mitmHosts.
   */
  mitmHosts?: RegExp;
  /**
   * True when this provider is a template rather than a choice.
   *
   * It exists so findCustomTemplate can hand the agent's own bin, env and
   * notes to a custom-base-url target, which has no ProviderEntry of its
   * own. It is never offered at the provider question and can never be
   * resolved directly, because it has no upstream host to forward to —
   * offering it would produce a target that silently forwards nowhere.
   *
   * An alwaysCustom agent needs no such flag: every one of its providers is
   * a template, and the wizard skips the question entirely. This is for the
   * agent that has both — one real route and one or more BYOK shapes.
   */
  templateOnly?: boolean;
}

interface AgentEntry {
  id: string;
  label: string;
  /** A supported agent has providers. A refused one has a reason. */
  providers?: ProviderEntry[];
  reason?: string;
  /**
   * True when every setup for this agent is a custom target: there is no
   * fixed catalogue provider to fall back to, so the wizard skips the
   * provider question and asks the two custom-base-url questions directly.
   * OMP is the first agent like this — it can point at Ollama, LM Studio,
   * llama.cpp, LiteLLM, or anything else, so no single upstream host is ever
   * right for it.
   */
  alwaysCustom?: boolean;
}

/**
 * Codex has no base URL environment variable. OPENAI_BASE_URL was read by older
 * versions and is gone from 0.133.0, so a student following an older guide gets
 * an empty logs folder and no error. The `-c` flag sets one config key for one
 * run, which is why it is used here in place of editing a file.
 */
const CODEX_OVERRIDE_NOTE =
  "The -c flag sets this for one run only. Your ~/.codex/config.toml is not " +
  "touched, so your normal Codex is unchanged the moment you stop using this " +
  "command. Keep the quotes exactly as they are: Codex reads the value as TOML, " +
  "and an unquoted URL does not parse.";

const PI_NOTE =
  "Pi has no base URL variable and no flag. A config file is the only way to " +
  "point it at this tool. Overriding the provider keeps Pi's whole built-in " +
  "model list, so you do not have to list the models yourself.";

/**
 * Pi's provider override file. The key is `baseUrl`, in this exact spelling.
 * Pi accepts other spellings into the file and then refuses to start, so this
 * is worth getting right for the student.
 *
 * `modelId`, when given, is written as a one-entry `models` array under the
 * same provider. Pi replaces that provider's whole built-in model catalogue
 * with whatever `models` lists — see resolveCustomTarget's Pi branch, which
 * is the only caller that passes it. Omitted, as it is for every catalogue
 * entry above, Pi keeps its built-in catalogue for that provider, which is
 * correct there because those routes really do talk to Anthropic or OpenAI.
 */
function piModels(
  providerId: string,
  baseUrl: string,
  modelId?: string
): SetupFile {
  return {
    path: "~/.pi/agent/models.json",
    language: "json",
    body: [
      "{",
      '  "providers": {',
      `    "${providerId}": {`,
      `      "baseUrl": "${baseUrl}"${modelId ? "," : ""}`,
      ...(modelId ? [`      "models": [{ "id": "${modelId}" }]`] : []),
      "    }",
      "  }",
      "}",
    ].join("\n"),
  };
}

/**
 * OMP's provider override file, in YAML, under ~/.omp/agent/models.yml.
 *
 * OMP does not know, and this tool cannot know, which backend the student is
 * actually pointing at — Ollama, LM Studio, llama.cpp, LiteLLM, or something
 * else entirely — so the provider key below is a generic placeholder
 * ("custom") rather than a real backend name. OMP does not care what the key
 * is called, only that baseUrl is set correctly under it, so the placeholder
 * costs the student nothing; they may rename it if they prefer a name that
 * matches their backend.
 */
function ompModels(baseUrl: string): SetupFile {
  return {
    path: "~/.omp/agent/models.yml",
    language: "yaml",
    body: ["providers:", "  custom:", `    baseUrl: "${baseUrl}"`].join("\n"),
  };
}

const OMP_NOTE =
  "OMP has no backend of its own to hard-code the way the rest of this " +
  "catalogue does. It can point at Ollama, LM Studio, llama.cpp, LiteLLM, or " +
  "any other server that speaks one of the wire formats offered here, so " +
  "every OMP setup goes through the base URL and wire format you chose.";

/**
 * Junie's custom-proxy override, in JSON, under ~/.junie/config.json (user
 * scope; see Junie's own configuration-files docs for how a project-scope
 * file layers on top). Unlike ompModels/piModels, this one genuinely differs
 * by wire format: Junie's proxy entry declares a `kind` — the protocol Junie
 * itself will speak on the wire — so a mismatched kind does not 404, it just
 * sends the wrong shape of request. That is why Junie gets two catalogue
 * providers below (tagged by customTemplateFor) instead of OMP's one: the
 * kind, and the auth header format that goes with it, must track the
 * renderer the student actually picked.
 *
 * `authHeader` is a placeholder line, not a real credential — see JUNIE_NOTE.
 */
function junieConfig(
  baseUrl: string,
  kind: "Anthropic" | "OpenAI",
  authHeader: string
): SetupFile {
  return {
    path: "~/.junie/config.json",
    language: "json",
    body: [
      "{",
      '  "proxies": [',
      "    {",
      '      "name": "request-logger",',
      `      "kind": "${kind}",`,
      `      "api-url": "${baseUrl}",`,
      `      "headers": ["${authHeader}"]`,
      "    }",
      "  ],",
      '  "provider": "request-logger"',
      "}",
    ].join("\n"),
  };
}

const JUNIE_NOTE =
  "Junie has no existing login for this tool to pass through the way Claude " +
  "Code or Codex do. Its custom proxy bypasses JetBrains AI authentication " +
  "entirely, so a real API key for whichever backend you are logging goes " +
  "straight into config.json's headers array in plaintext. Do not commit " +
  "this file.";

const JUNIE_MERGE_NOTE =
  "This is merged into ~/.junie/config.json, not a replacement for it — add " +
  "the proxies entry and the provider key alongside whatever else is " +
  "already in that file.";

/**
 * Qoder CLI (`qodercli`) reaches models two unrelated ways, and both are
 * logged here — by two providers that share nothing but the binary.
 *
 * The BYOK route is the ordinary shape: Qoder calls a base URL you give it,
 * in a standard wire format, with nothing between the two. That is Junie's
 * and OMP's shape, so it needs no renderer of its own — the wire format
 * chosen at the wizard decides how the capture reads. It does sit behind a
 * server-side feature gate, which is what QODER_GATE_WARNING is for.
 *
 * The subscription route is the one this catalogue had not met before.
 * Qoder builds its system prompt and its tool schemas on your machine and
 * really does send them, so unlike Cursor and Amp there is nothing here
 * that a proxy cannot in principle read. Two things still stop the obvious
 * approach:
 *
 *  - It elects its own upstream host at runtime (a region lookup plus
 *    Aliyun HTTPDNS) and offers no base-URL override at all.
 *    `QODER_MODEL_SERVER_HOST` exists in the
 *    binary but belongs to a newer transport that is gated off, so it is
 *    never read on this route. There is therefore no URL to hand Qoder —
 *    the only way to stand between the two is `HTTPS_PROXY`, which makes
 *    this a man-in-the-middle rather than a reverse proxy.
 *  - It encodes the request body before it leaves the process. That is
 *    obfuscation, not encryption: a fixed substitution with no key, no
 *    nonce and no MAC, derived from qodercli's own WASM module and
 *    reversed in qoder-codec.ts. The response needs nothing of the kind —
 *    it comes back as OpenAI-shaped JSON over SSE.
 *
 * Both facts are recorded in the warnings below rather than in a refusal,
 * because neither one stops the capture from being read.
 *
 * Qoder's own docs tell you not to hand-edit its settings file for BYOK, so
 * unlike Junie there is no setup file on either provider: the BYOK base URL
 * goes into qodercli's own /model → Custom wizard, and the subscription
 * route is configured entirely by the command's two variables.
 */
const QODER_ANTHROPIC_NOTE =
  "In qodercli, run /model, choose Custom, set the protocol to anthropic and " +
  "paste this base URL: {baseUrl} — with no /v1 on the end. Qoder appends " +
  "the whole /v1/messages path itself, so a base URL that already carries /v1 " +
  "produces /v1/v1/messages and a 404 that looks like this tool is broken. " +
  "Qoder also asks for an API key and a model ID; both have to be real ones " +
  "for whichever provider you are logging, because this tool only stands " +
  "between the two and forwards what it is given.";

const QODER_OPENAI_NOTE =
  "In qodercli, run /model, choose Custom, set the protocol to openai — or " +
  "openai-responses, which this tool reads the same way it reads Codex's — " +
  "and paste this base URL: {baseUrl}. The /v1 stays on it here, and the " +
  "banner above prints the listening address without it: Qoder appends only " +
  "/chat/completions for openai and /responses for openai-responses, so " +
  "pasting the shorter form sends the call to a path nothing answers. Qoder " +
  "also asks for an API key and a model ID; both have to be real ones for " +
  "whichever provider you are logging, because this tool only stands between " +
  "the two and forwards what it is given.";

const QODER_GATE_WARNING =
  "Qoder's BYOK route sits behind a server-side feature gate Qoder calls " +
  "custom_providers, and its own docs put the feature on the Individual " +
  "plan. If /model shows no Custom option, your account does not have the " +
  "gate, and nothing you write into a local config file will make it " +
  "appear — the check happens against Qoder's servers on every start. Run " +
  "with --force and pick Qoder's subscription route instead if yours is " +
  "gated: that one needs no gate, and no base URL either.";

const QODER_SUBSCRIPTION_NOTE =
  "This route needs no base URL and no API key from you. qodercli keeps its " +
  "own login and picks its own server at runtime, so the two variables above " +
  "are what point it here instead: HTTPS_PROXY sends its traffic to this " +
  "proxy, and NODE_EXTRA_CA_CERTS lets it trust the certificate this proxy " +
  "then has to present. Both are set for that one command only — your normal " +
  "qodercli, in any other terminal, is untouched.";

const QODER_MITM_WARNING =
  "This is a man-in-the-middle, which no other route in this catalogue is. " +
  "To read a request this proxy has to end qodercli's TLS connection itself " +
  "and open a second one to Qoder, so it mints a certificate for each host it " +
  "decrypts as that connection opens. Minting one needs `openssl` on your " +
  "PATH, and it needs a CA: both are written under request-logger/.mitm/, " +
  "both are gitignored, and both are deleted when this proxy stops. " +
  "NODE_EXTRA_CA_CERTS is read by that one qodercli process and by nothing " +
  "else — your system trust store is never changed. Setting HTTPS_PROXY also " +
  "makes qodercli drop its gRPC transport for plain HTTP, which it does on " +
  "purpose and logs; that is the transport this route reads anyway.";

const QODER_MITM_TRAFFIC_WARNING =
  "HTTPS_PROXY sends *all* of qodercli's HTTPS traffic through here, not " +
  "just the model call: sign-in, telemetry, codebase indexing, downloads and " +
  "the region lookup that elects the host all arrive too. This proxy decrypts " +
  "only the hosts a model call can be on. Every other tunnel is joined " +
  "straight to the host it named and passes through unread, so those calls " +
  "reach Qoder exactly as they would have without this tool — which matters " +
  "because qodercli holds more than one TLS client, and not all of them read " +
  "NODE_EXTRA_CA_CERTS. Inside a decrypted tunnel, the calls that are not " +
  "inference are forwarded untouched and reported as housekeeping. Only the " +
  "inference calls are written to your logs folder.";

const QODER_ENCODER_WARNING =
  "Qoder encodes this route's request body before it leaves the process. " +
  "This tool decodes it with the scheme reversed from qodercli's own WASM " +
  "module (see qoder-codec.ts), verified byte-for-byte against 1.1.45, " +
  "1.1.46 and 1.1.47. It is a fixed substitution with no key rather than " +
  "encryption, but it is Qoder's to change — and a Qoder update that does " +
  "makes every capture say so loudly at the top, rather than quietly " +
  "showing you gibberish.";

/**
 * Antigravity CLI (`agy`) is a separate Google product from Gemini CLI — a
 * different binary, a different agent harness — but its API-key route stores
 * its settings under Gemini CLI's own directory (`~/.gemini/...`) and, per
 * Google's docs, calls the public Gemini API directly and reads the exact
 * same GOOGLE_GEMINI_BASE_URL variable Gemini CLI's own API-key route does.
 * The existing "gemini" renderer already reads that wire format correctly,
 * so this entry needed no renderer of its own — only a catalogue entry with
 * the right bin and the settings file that switches this route on.
 */
const ANTIGRAVITY_NOTE =
  "Antigravity CLI is a different product from Gemini CLI, with its own " +
  "binary (agy, not gemini). This route works the same as Gemini CLI's API " +
  "key route, though: both call the public Gemini API directly and read the " +
  "same GOOGLE_GEMINI_BASE_URL variable, so the existing gemini renderer " +
  "reads this capture correctly with no changes.";

const ANTIGRAVITY_KEY_NOTE =
  "GEMINI_API_KEY must also be exported in your shell, and modelProvider " +
  'must be "gemini" in the settings file below. Without both, Antigravity ' +
  "CLI falls back to its own account sign-in instead — a different, " +
  "unverified route this catalogue does not cover yet (see the warning below).";

const ANTIGRAVITY_MERGE_NOTE =
  "This is merged into ~/.gemini/antigravity-cli/settings.json, not a " +
  "replacement for it — add modelProvider alongside whatever else is " +
  "already in that file.";

const ANTIGRAVITY_LOGIN_WARNING =
  "This entry covers the Gemini API key route only. Antigravity CLI's " +
  "default account sign-in was not verified against real source (it is " +
  "closed source) or a real login, and public reporting on the Antigravity " +
  "IDE suggests its account-login traffic can go to a different, internal " +
  "host rather than the Code Assist host Gemini CLI's own free login uses — " +
  "so this catalogue does not claim that route works. Ask for it via the " +
  "issue tracker if you need it logged.";

const OPENCODE_NOTE =
  "The environment variable above works, but only by accident: OpenCode passes " +
  "no base URL of its own for this provider, so the bundled SDK falls back to " +
  "reading the variable. The config file below is the durable way to do it.";

/**
 * Ordered by popularity, decided 2026-08-06. The wizard shows them in this
 * order, so a student is most likely to find theirs first.
 */
const AGENTS: AgentEntry[] = [
  {
    id: "claude-code",
    label: "Claude Code",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        env: [
          ["ANTHROPIC_BASE_URL", "{baseUrl}"],
          ["ENABLE_TOOL_SEARCH", "true"],
        ],
        bin: "claude",
        // Claude Code's own wire format is Anthropic-shaped regardless of
        // what a custom target claims to speak, so this stays the catch-all
        // for every wire format a custom target might pick — the same
        // "used regardless of the wire format chosen" guarantee this agent
        // had when it was the only provider, back when findCustomTemplate's
        // single-provider branch picked it unconditionally. Now that
        // "vertex" (below) is a second provider, that branch no longer
        // fires, so the guarantee has to be spelled out here instead.
        customTemplateFor: ["anthropic", "openai", "raw"],
        notes: [
          "ENABLE_TOOL_SEARCH=true is important. Claude Code trusts one host only. " +
            "When the base URL points somewhere else, it turns off tool search, stops " +
            "deferring tools, and writes every tool schema into the request. Your " +
            "capture is then larger than a real one and has a different shape. The " +
            "flag turns that effect off, so what you read is what Claude Code really sends.",
          "This works with a Claude subscription login. Your login stays active. " +
            "Only the model traffic moves.",
        ],
      },
      {
        id: "vertex",
        label: "Google Vertex AI",
        // Fixed to the global endpoint on purpose — see the region note below.
        upstreamHost: "aiplatform.googleapis.com",
        // Vertex's Claude endpoint is Anthropic's own Messages API shape,
        // routed by URL path instead of a body field — the model ID moves
        // from the body's "model" key into the URL
        // (.../publishers/anthropic/models/{model}:streamRawPredict), and
        // the body gains "anthropic_version". findModel() in render.ts
        // already falls back to reading the model out of the path when the
        // body has none, and the Anthropic renderer only reads specific
        // known keys, so the existing "anthropic" renderer reads this
        // correctly without a dedicated renderer of its own.
        renderer: "anthropic",
        env: [
          ["ANTHROPIC_VERTEX_BASE_URL", "{baseUrl}"],
          ["ENABLE_TOOL_SEARCH", "true"],
        ],
        bin: "claude",
        notes: [
          "This assumes CLAUDE_CODE_USE_VERTEX=1, CLOUD_ML_REGION and " +
            "ANTHROPIC_VERTEX_PROJECT_ID are already exported in your shell — " +
            "request-logger does not set those, only ANTHROPIC_VERTEX_BASE_URL, " +
            "which is the variable Claude Code actually reads for a base-URL " +
            "override once Vertex mode is on. ANTHROPIC_BASE_URL, used by the " +
            "plain Anthropic route above, is silently ignored in Vertex mode — " +
            "that mismatch is the usual reason a Vertex student's logs folder " +
            "stays empty.",
          "Only CLOUD_ML_REGION=global is supported by this entry. A regional " +
            "value (us-east5, say) talks to a different host " +
            "({region}-aiplatform.googleapis.com), which this entry does not " +
            "resolve to yet — ask for it via the issue tracker if you hit this.",
          "ENABLE_TOOL_SEARCH=true matters here for the same reason it does on " +
            "the plain Anthropic route above: a non-default host turns off tool " +
            "search unless this is set.",
        ],
      },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    providers: [
      {
        id: "chatgpt",
        label: "ChatGPT subscription",
        upstreamHost: "chatgpt.com",
        renderer: "openai",
        // Codex joins the base URL and the word `responses` with one slash, so
        // the base URL must carry the whole prefix that it would otherwise use,
        // which is https://chatgpt.com/backend-api/codex.
        suffix: "/backend-api/codex",
        bin: "codex",
        args: ["-c", `'openai_base_url="{baseUrl}"'`],
        notes: [CODEX_OVERRIDE_NOTE],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        // The API key route defaults to https://api.openai.com/v1, and Codex
        // appends `responses` to it, so the base URL keeps the /v1.
        suffix: "/v1",
        bin: "codex",
        args: ["-c", `'openai_base_url="{baseUrl}"'`],
        // The only usable template for a custom Codex target: Codex only
        // ever speaks the OpenAI-compatible wire format, so it is the
        // catch-all for every choice, including "anthropic" — a mismatch
        // there is Codex's limitation, not a bug in this tool.
        customTemplateFor: ["openai", "raw", "anthropic"],
        notes: [CODEX_OVERRIDE_NOTE],
      },
    ],
  },
  {
    id: "copilot",
    label: "GitHub Copilot CLI",
    providers: [
      {
        id: "github",
        label: "GitHub subscription",
        upstreamHost: "api.githubcopilot.com",
        renderer: "openai",
        env: [["COPILOT_API_URL", "{baseUrl}"]],
        bin: "copilot",
        notes: [
          "Copilot's built-in MCP servers add their tools to every request, and " +
            "they make calls of their own, so you get more documents than turns " +
            "you typed. That is what your agent really sends, so it is worth " +
            "reading once. If you want a smaller capture, add " +
            "--disable-builtin-mcps to the command.",
        ],
        warnings: [
          "Some models negotiate a WebSocket transport. This tool cannot see a " +
            "WebSocket, so those turns write no log at all. If your logs folder " +
            "stays empty, try a different model. gpt-5.1 used plain HTTP in testing.",
        ],
      },
    ],
  },
  {
    id: "cursor",
    label: "Cursor CLI",
    reason:
      "Cursor builds its system prompt on its own servers. The request that " +
      "leaves your machine holds your message and very little else, so there is " +
      "no system prompt and no tool list for this tool to show you. No proxy can " +
      "read what your machine never sends. Search the whole shipped Cursor " +
      "bundle and you will find no system prompt text and no tool schemas.",
  },
  {
    id: "opencode",
    label: "OpenCode",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        suffix: "/v1",
        env: [["ANTHROPIC_BASE_URL", "{baseUrl}"]],
        bin: "opencode",
        customTemplateFor: ["anthropic"],
        setup: [
          {
            path: "~/.config/opencode/opencode.json",
            language: "json",
            body: [
              "{",
              '  "$schema": "https://opencode.ai/config.json",',
              '  "model": "anthropic/claude-sonnet-4-5",',
              '  "small_model": "anthropic/claude-sonnet-4-5",',
              '  "provider": {',
              '    "anthropic": {',
              '      "options": {',
              '        "apiKey": "{env:ANTHROPIC_API_KEY}",',
              '        "baseURL": "{baseUrl}"',
              "      }",
              "    }",
              "  }",
              "}",
            ].join("\n"),
          },
        ],
        notes: [
          OPENCODE_NOTE,
          "OpenCode never counts tokens. Instead it makes a second call with its " +
            "small model to title the thread, so one turn writes exactly two captures.",
        ],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        suffix: "/v1",
        env: [["OPENAI_BASE_URL", "{baseUrl}"]],
        bin: "opencode",
        // Also the catch-all for "raw"/not sure: a third-party server behind
        // a custom base URL is far more often OpenAI-compatible than
        // Anthropic-compatible, so this is the better default guess.
        customTemplateFor: ["openai", "raw"],
        setup: [
          {
            path: "~/.config/opencode/opencode.json",
            language: "json",
            body: [
              "{",
              '  "$schema": "https://opencode.ai/config.json",',
              '  "model": "openai/gpt-5.1",',
              '  "small_model": "openai/gpt-5.1",',
              '  "provider": {',
              '    "openai": {',
              '      "options": {',
              '        "apiKey": "{env:OPENAI_API_KEY}",',
              '        "baseURL": "{baseUrl}"',
              "      }",
              "    }",
              "  }",
              "}",
            ].join("\n"),
          },
        ],
        notes: [
          OPENCODE_NOTE,
          "OpenCode uses a different system prompt for each provider. Run it once " +
            "against Anthropic and once against OpenAI and compare the two captures.",
        ],
        warnings: [
          "A ChatGPT login will not work here. OpenCode sends that traffic to a " +
            "different host on purpose, so it goes around this tool. Use an " +
            "OpenAI API key.",
        ],
      },
    ],
  },
  {
    id: "pi",
    label: "Pi",
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        upstreamHost: "api.anthropic.com",
        renderer: "anthropic",
        bin: "pi",
        customTemplateFor: ["anthropic"],
        setup: [piModels("anthropic", "{baseUrl}")],
        notes: [
          PI_NOTE,
          "This route works with an Anthropic API key and with a Claude " +
            "subscription login.",
          "Pi never counts tokens, so every file in your logs folder is a real turn.",
        ],
      },
      {
        id: "openai",
        label: "OpenAI API key",
        upstreamHost: "api.openai.com",
        renderer: "openai",
        // Pi hands this to the OpenAI SDK, which appends `/responses`.
        suffix: "/v1",
        bin: "pi",
        // Also the catch-all for "raw"/not sure — see the OpenCode entry
        // above for why an OpenAI-compatible guess is the better default.
        customTemplateFor: ["openai", "raw"],
        setup: [piModels("openai", "{baseUrl}")],
        notes: [PI_NOTE],
      },
      {
        id: "codex",
        label: "ChatGPT subscription (Codex)",
        upstreamHost: "chatgpt.com",
        renderer: "openai",
        // Pi appends `/codex/responses` itself, and the real endpoint lives
        // under `/backend-api`. Without this suffix the forwarded path would be
        // missing that segment and the request would fail.
        suffix: "/backend-api",
        bin: "pi",
        setup: [
          piModels("openai-codex", "{baseUrl}"),
          {
            path: "~/.pi/agent/settings.json",
            language: "json",
            body: ["{", '  "transport": "sse"', "}"].join("\n"),
          },
        ],
        notes: [
          PI_NOTE,
          "The SSE transport is not optional on this route. Pi's default tries " +
            "a WebSocket first, and this tool cannot see a WebSocket. The " +
            "setting goes in the settings file, not in the models file. Pi " +
            "accepts it in the models file and then quietly ignores it.",
          "Pi compresses the request body on this route. The readable .md file " +
            "shows the decoded body. The .request.txt file keeps the compressed " +
            "bytes exactly as sent, so you can still replay it.",
        ],
      },
    ],
  },
  {
    id: "omp",
    label: "OMP (Oh My Pi)",
    // Every setup for OMP goes through the custom-base-url questions — see
    // AgentEntry.alwaysCustom. The one provider below never reaches the
    // wizard; it exists purely to hold the bin and setup-file template that
    // resolveCustomTarget borrows from, the same way findCustomTemplate
    // borrows from a real provider for every other agent.
    alwaysCustom: true,
    providers: [
      {
        id: CUSTOM_ID,
        label: CUSTOM_LABEL,
        // Unused: OMP never reaches the normal (non-custom) resolution path
        // that would read this.
        upstreamHost: "",
        // Irrelevant here too — the resolved renderer always comes from the
        // student's answer, not from this template. See resolveCustomTarget.
        renderer: "raw",
        bin: "omp",
        setup: [ompModels("{baseUrl}")],
        notes: [OMP_NOTE],
      },
    ],
  },
  {
    id: "gemini",
    label: "Gemini CLI",
    providers: [
      {
        id: "google-login",
        label: "Free Google account login",
        upstreamHost: "cloudcode-pa.googleapis.com",
        renderer: "gemini",
        env: [["CODE_ASSIST_ENDPOINT", "{baseUrl}"]],
        bin: "gemini",
        notes: [
          "This is the free tier. You do not need to buy anything to finish the lesson.",
          "On this route Gemini also makes several housekeeping calls that carry no " +
            "prompt. This tool forwards them but does not log them, so your logs " +
            "folder holds real turns only.",
        ],
      },
      {
        id: "api-key",
        label: "Gemini API key",
        upstreamHost: "generativelanguage.googleapis.com",
        renderer: "gemini",
        env: [["GOOGLE_GEMINI_BASE_URL", "{baseUrl}"]],
        bin: "gemini",
        // The only usable template for a custom Gemini CLI target: the
        // Google-login route is tied to that login and would misconfigure an
        // unrelated server. Gemini CLI's own wire format does not actually
        // match any of the custom choices, so this is a best-effort catch-all
        // for all three — a mismatch shows up as a renderer warning, not a
        // silent one.
        customTemplateFor: ["openai", "anthropic", "raw"],
        warnings: [
          "The two Gemini routes use different variables and they are not " +
            "interchangeable. GOOGLE_GEMINI_BASE_URL is ignored under a Google " +
            "account login, and CODE_ASSIST_ENDPOINT is ignored under an API key. " +
            "Neither one gives you an error. You just get an empty logs folder.",
        ],
      },
    ],
  },
  {
    id: "antigravity",
    label: "Antigravity CLI",
    providers: [
      {
        id: "api-key",
        label: "Gemini API key",
        upstreamHost: "generativelanguage.googleapis.com",
        renderer: "gemini",
        env: [["GOOGLE_GEMINI_BASE_URL", "{baseUrl}"]],
        bin: "agy",
        setup: [
          {
            path: "~/.gemini/antigravity-cli/settings.json",
            language: "json",
            body: ["{", '  "modelProvider": "gemini"', "}"].join("\n"),
          },
        ],
        notes: [ANTIGRAVITY_NOTE, ANTIGRAVITY_KEY_NOTE, ANTIGRAVITY_MERGE_NOTE],
        warnings: [ANTIGRAVITY_LOGIN_WARNING],
      },
    ],
  },
  {
    id: "junie",
    label: "Junie",
    // Junie is BYOK across several backends (OpenAI, Anthropic, Google, xAI,
    // OpenRouter, Copilot, a LiteLLM proxy) with no single fixed host of its
    // own — the same shape as OMP — so every setup for it is custom too. See
    // AgentEntry.alwaysCustom.
    //
    // Junie CLI is closed source, so unlike every other entry in this
    // catalogue this one is verified against JetBrains' published docs only,
    // not against real source or a real install. Testing status is recorded
    // in the README's "How much this was tested" section, the same way every
    // other agent's is; it is not printed to the student, the same way no
    // other agent's is either.
    alwaysCustom: true,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic-compatible",
        // Unused: Junie never reaches the normal (non-custom) resolution
        // path that would read this. See resolveCustomTarget.
        upstreamHost: "",
        renderer: "raw",
        bin: "junie",
        customTemplateFor: ["anthropic"],
        setup: [
          junieConfig(
            "{baseUrl}",
            "Anthropic",
            "x-api-key: YOUR_ANTHROPIC_API_KEY"
          ),
        ],
        notes: [JUNIE_NOTE, JUNIE_MERGE_NOTE],
      },
      {
        id: "openai",
        label: "OpenAI-compatible",
        // Unused, same as the Anthropic-compatible entry above: Junie never
        // reaches the normal (non-custom) resolution path that would read
        // this. See resolveCustomTarget.
        upstreamHost: "",
        renderer: "raw",
        bin: "junie",
        // Also the catch-all for "raw"/not sure — see the OpenCode and Pi
        // entries above for why an OpenAI-compatible guess is the better
        // default for an unidentified custom server.
        customTemplateFor: ["openai", "raw"],
        setup: [
          junieConfig(
            "{baseUrl}",
            "OpenAI",
            "Authorization: Bearer YOUR_OPENAI_API_KEY"
          ),
        ],
        notes: [JUNIE_NOTE, JUNIE_MERGE_NOTE],
      },
    ],
  },
  {
    id: "qoder",
    label: "Qoder",
    // Not alwaysCustom, unlike Junie and OMP: the subscription route below is
    // a real catalogue provider, with a real renderer and a real command, so
    // the wizard offers it directly. The two BYOK entries after it are
    // templates only — see templateOnly — reached through the "Custom base
    // URL" option every supported agent already offers.
    //
    // Verified against qodercli 1.1.45/46/47. The subscription route was
    // driven end to end by intercepting its TLS traffic, and its body encoder
    // was checked byte-for-byte against the WASM module that produces it. The
    // BYOK route was verified only as far as the config schema it accepts:
    // the account this was researched on has the custom_providers gate
    // switched off. Testing status is recorded in the README's "How much this
    // was tested" section, the same way every other agent's is.
    providers: [
      {
        id: "subscription",
        label: "Qoder subscription (default)",
        // Empty on purpose. This route elects its own host at runtime and
        // offers no override, so the real host is only known once qodercli
        // sends CONNECT — mitm.ts fills it in per connection. See
        // ResolvedTarget.mitm.
        upstreamHost: "",
        renderer: "qoder",
        bin: "qodercli",
        mitm: true,
        // Both shapes a model call has been seen on, from qodercli's own
        // `endpoint=` log field: a bare `api<N>.qoder.<apex>` and a
        // tenant-prefixed `<tenant>-api.qoder.<apex>`. The region election
        // picks between them per run and the bare shape is the more common of
        // the two, so matching only one of them makes logging a coin flip —
        // the inference tunnel is spliced through unread and nothing is
        // written. Everything else qodercli dials is left alone: `center` for
        // the election itself, `openapi` for sign-in and feature gates, both
        // on either apex, OSS for downloads, and third parties for MCP servers
        // and npm. Those arrive on tunnels owned by TLS clients that do not all
        // read NODE_EXTRA_CA_CERTS, so decrypting them breaks calls that carry
        // nothing worth reading. The `^` and the `-api` anchor are what keep
        // `openapi` and `center` out, including the tenant-prefixed ones.
        mitmHosts: /^(?:[^.]*-)?api\d*\.qoder\.(xin|sh|com\.cn|com|ai)$/i,
        env: [
          ["HTTPS_PROXY", "{proxyUrl}"],
          ["NODE_EXTRA_CA_CERTS", "{caPath}"],
        ],
        notes: [QODER_SUBSCRIPTION_NOTE],
        warnings: [
          QODER_MITM_WARNING,
          QODER_MITM_TRAFFIC_WARNING,
          QODER_ENCODER_WARNING,
        ],
      },
      {
        id: "anthropic",
        label: "Anthropic-compatible",
        // Unused: a template is never resolved directly. See templateOnly and
        // resolveCustomTarget.
        upstreamHost: "",
        renderer: "raw",
        bin: "qodercli",
        templateOnly: true,
        customTemplateFor: ["anthropic"],
        notes: [QODER_ANTHROPIC_NOTE],
        warnings: [QODER_GATE_WARNING],
      },
      {
        id: "openai",
        label: "OpenAI-compatible",
        // Unused, same as the Anthropic-compatible entry above.
        upstreamHost: "",
        renderer: "raw",
        bin: "qodercli",
        templateOnly: true,
        // Also the catch-all for "raw"/not sure — see the OpenCode, Pi and
        // Junie entries above for why an OpenAI-compatible guess is the
        // better default for an unidentified custom server.
        customTemplateFor: ["openai", "raw"],
        // Qoder appends only the last path segment for these two protocols,
        // so the /v1 has to already be on the base URL this prints.
        suffix: "/v1",
        notes: [QODER_OPENAI_NOTE],
        warnings: [QODER_GATE_WARNING],
      },
    ],
  },
  {
    id: "amp",
    label: "Amp",
    reason:
      "Amp builds its system prompt on its own servers, the same as Cursor. " +
      "Amp does have a URL setting, but it points at Amp's own server, not at " +
      "the model endpoint, so it cannot help you here.",
  },
];

// ---------------------------------------------------------------------------
// Reading the catalogue
// ---------------------------------------------------------------------------

export interface AgentSummary {
  id: string;
  label: string;
  supported: boolean;
  /** True when the student must also be asked which model provider they use. */
  needsProvider: boolean;
  /** True when this agent has no catalogue provider: every setup is custom. */
  alwaysCustom: boolean;
}

export interface ProviderSummary {
  id: string;
  label: string;
}

/**
 * Every agent the wizard offers, in the order it offers them.
 *
 * The catalogue is written in order of popularity. The list is then sorted so
 * the agents that cannot be logged sit at the bottom, because a student picking
 * from the top should meet the ones that work first. The sort is stable, so
 * popularity still decides the order inside each group.
 */
export function listAgents(): AgentSummary[] {
  const summaries = AGENTS.map((agent) => ({
    id: agent.id,
    label: agent.label,
    supported: agent.providers != null,
    // An alwaysCustom agent never shows the provider question — askChoice
    // skips straight past it (see agent.alwaysCustom above) — regardless of
    // how many internal templates its catalogue entry holds for
    // findCustomTemplate to pick between. Junie is the first alwaysCustom
    // agent with more than one, so this used to be true by coincidence for
    // every alwaysCustom agent (OMP has exactly one provider); it is
    // spelled out here now that a second one exists.
    //
    // Templates are excluded from the count for every agent, not just
    // alwaysCustom ones: they are not providers to choose between, and
    // counting them would say Qoder has three when it has one.
    needsProvider: !agent.alwaysCustom && visibleProviders(agent).length > 1,
    alwaysCustom: agent.alwaysCustom === true,
  }));
  return [
    ...summaries.filter((agent) => agent.supported),
    ...summaries.filter((agent) => !agent.supported),
  ];
}

/**
 * The providers a student can actually pick. Drops the templates, which
 * exist to shape a custom target and would otherwise be offered as choices
 * that resolve to a target with no upstream host. See ProviderEntry.
 * templateOnly.
 */
function visibleProviders(agent: AgentEntry | undefined): ProviderEntry[] {
  return (agent?.providers ?? []).filter((p) => p.templateOnly !== true);
}

/**
 * The providers to ask about for one agent, when there is more than one to
 * choose between. Empty when there is nothing to ask — a refused agent has
 * none, and an agent with exactly one provider is assumed rather than asked.
 *
 * This stays gated at two on purpose, unchanged by the custom-base-url
 * mechanism: it describes the catalogue, not the wizard's options. See
 * agentProviders for the list config.ts actually builds the provider
 * question's options from, which is not gated this way.
 */
export function listProviders(agentId: string): ProviderSummary[] {
  const agent = AGENTS.find((a) => a.id === agentId);
  const providers = visibleProviders(agent);
  if (providers.length < 2) return [];
  return providers.map((p) => ({ id: p.id, label: p.label }));
}

/**
 * Every provider one agent offers at the wizard, regardless of how many
 * there are — which is every catalogue provider except the templates.
 *
 * config.ts uses this, not listProviders, to build the provider question's
 * options — because "Custom base URL" is now offered at that question for
 * every supported agent, even one with a single catalogue provider, there is
 * always something to pick between even when listProviders would say there
 * is nothing to ask about.
 */
export function agentProviders(agentId: string): ProviderSummary[] {
  const agent = AGENTS.find((a) => a.id === agentId);
  return visibleProviders(agent).map((p) => ({ id: p.id, label: p.label }));
}

// ---------------------------------------------------------------------------
// Which requests are worth writing down
// ---------------------------------------------------------------------------

/**
 * Some calls reach the model provider but never produce a model reply. One turn
 * fires several of them, so they are noise for "what is sent to the model". The
 * proxy forwards them all. It only writes down the ones this returns true for.
 *
 *  - A model call is always a POST. Agents also send connectivity probes, which
 *    would otherwise write an empty document at the top of the logs folder.
 *  - The direct Anthropic API counts tokens with a `count_tokens` path.
 *    Claude Code on Vertex AI reaches the same Anthropic wire format through a
 *    Vertex-style URL instead, whose token-counting call ends
 *    `:countTokens` — Vertex's own camelCase, colon-suffixed convention,
 *    not Anthropic's underscored one — so both spellings are matched below.
 *  - Gemini counts tokens under a different name, and on the Google login route
 *    it fires several calls that carry no prompt at all. On that route the only
 *    calls worth keeping are the ones that generate content.
 *  - Qoder's subscription route is that case taken further. It arrives over
 *    MITM, so what this sees is not one agent's model traffic but every HTTPS
 *    call the whole process makes — sign-in, telemetry, codebase indexing, the
 *    region lookup that elects the host. A blacklist cannot describe that, so
 *    this is a whitelist of the two paths that actually carry a prompt.
 */
export function shouldLogRequest(
  method: string,
  reqPath: string,
  renderer: RendererId
): boolean {
  if (method.toUpperCase() !== "POST") return false;
  // Case-insensitive on purpose: the streaming call is `:streamGenerateContent`,
  // with a capital G, and the non-streaming one is `:generateContent`.
  if (renderer === "gemini") return /generateContent/i.test(reqPath);
  // `agent_chat_generation` is the subscription route's inference call, under
  // whichever host the region lookup elected. The second path is the
  // plain-HTTP transport qodercli also carries, which posts the same
  // request unencoded; it is not what HTTPS_PROXY selects, but it renders the
  // same way and would otherwise be dropped as housekeeping.
  if (renderer === "qoder") {
    return /agent_chat_generation|\/model\/v1\/chat\/completions/.test(reqPath);
  }
  // Matches both `count_tokens` (direct Anthropic API) and `countTokens`
  // (Claude Code on Vertex AI).
  return !/count[_-]?tokens/i.test(reqPath);
}

// ---------------------------------------------------------------------------
// Resolution — the seam
// ---------------------------------------------------------------------------

/**
 * The values a catalogue entry can name in `{braces}`.
 *
 * `port` is passed in rather than parsed back out of `baseUrl` because the
 * two URL placeholders do not want the same string. `baseUrl` is what the
 * agent is told to call, and carries any suffix the agent must not add
 * itself. `proxyUrl` is what HTTPS_PROXY wants: a bare origin, and on
 * 127.0.0.1 rather than localhost — a proxy that resolves "localhost" to ::1
 * first is unreachable for an agent that only ever tries the IPv4 answer.
 *
 * `caPath` is the one placeholder not derived from anything the caller
 * knows: it is where certs.ts writes the CA it mints, and this module
 * imports that path rather than repeating it, so the printed command and the
 * file on disk cannot drift apart. Reading it is path arithmetic, so
 * resolveChoice stays pure — nothing touches the disk here.
 *
 * A name this does not know is left in the output rather than blanked, so a
 * typo in a catalogue entry shows up in the printed command instead of
 * silently vanishing from it.
 */
function placeholderValues(baseUrl: string, port: number): Record<string, string> {
  return {
    baseUrl,
    proxyUrl: `http://127.0.0.1:${port}`,
    caPath: CA_CERT_PATH,
  };
}

function buildCommand(
  provider: ProviderEntry,
  baseUrl: string,
  options: { port: number; platform: NodeJS.Platform }
): string {
  const values = placeholderValues(baseUrl, options.port);
  const fill = (text: string) =>
    text.replace(/\{(\w+)\}/g, (whole, name: string) => values[name] ?? whole);
  const env = (provider.env ?? []).map(
    ([key, value]) => [key, fill(value)] as const
  );
  // Arguments take the base URL too. Codex has no variable for it, so its
  // whole override arrives as a flag.
  const args = (provider.args ?? []).map(fill);
  const bin = [provider.bin, ...args].join(" ");
  return withEnv(env, bin, options.platform);
}

/**
 * Join one or more `KEY=value` environment assignments onto the command that
 * needs them, in whichever syntax the student's shell actually understands.
 *
 * POSIX shells — bash, zsh, and Windows' own WSL and Git Bash — accept
 * `KEY=value KEY2=value2 bin` directly, so that is the default this tool has
 * always printed. Windows' native PowerShell has no such syntax at all: typed
 * back verbatim, it comes back as "is not recognized as a name of a cmdlet"
 * (the report that prompted this function). PowerShell instead sets each
 * variable with its own `$env:KEY = 'value'` statement, chained onto one
 * line with semicolons the way PowerShell joins statements.
 */
function withEnv(
  env: ReadonlyArray<readonly [string, string]>,
  bin: string,
  platform: NodeJS.Platform
): string {
  if (env.length === 0) return bin;
  if (platform === "win32") {
    return [
      ...env.map(([key, value]) => `$env:${key} = ${powerShellQuote(value)}`),
      bin,
    ].join("; ");
  }
  return [
    ...env.map(
      ([key, value]) => `${key}=${posixSafe(value) ? value : shellQuote(value)}`
    ),
    bin,
  ].join(" ");
}

/**
 * Whether a value survives a POSIX shell unquoted.
 *
 * Everything this tool printed before MITM mode is a URL or a bare path, made
 * only of characters a shell reads literally, so leaving them unquoted has
 * always been correct — and stays correct, which matters because the printed
 * commands are tested verbatim. An absolute path with a space in it is the
 * first value that is not: this repo lives under whatever directory the
 * student cloned it into. Unquoted, such a path splits into two words and the
 * command runs with the variable set to the first half of it, which fails as
 * a TLS error a long way from its cause.
 */
function posixSafe(value: string): boolean {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value);
}

/** Quote one complete POSIX shell argument, including embedded single quotes. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

/**
 * Quote one complete PowerShell string literal, including embedded single
 * quotes (PowerShell escapes those by doubling them, not by backslash).
 * Single-quoted PowerShell strings do no interpolation at all — unlike
 * double-quoted ones, where a `$` in a base URL or a JSON config would be
 * read as the start of a variable — so this is the literal, injection-safe
 * quoting PowerShell offers.
 */
function powerShellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Turn what the student typed into an origin (scheme + host [+ port]), or
 * nothing. Only http and https make sense here — the proxy speaks plain HTTP
 * to whatever it forwards to, over either transport — so anything else (a
 * bare host with no scheme, a typo, an unrelated protocol) is rejected
 * rather than guessed at. A wrong guess would fail as a confusing connection
 * error; this fails as a message the student can act on.
 */
function parseUpstreamUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  return url;
}

/**
 * The upstream a CustomTarget forwards to: origin plus any path prefix the
 * student typed, e.g. https://opencode.ai/zen/go. A bare origin's pathname
 * is "/", which collapses to nothing here so a path-free base URL still
 * round-trips to exactly its origin. Any trailing slash on a typed prefix is
 * dropped too, so proxy.ts can join this against a leading-slash request
 * path (e.g. /v1/chat/completions) with plain concatenation and never
 * produce a doubled or missing slash.
 */
function upstreamBaseUrlWithPath(url: URL): string {
  const prefix = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${prefix}`;
}

/**
 * Which catalogue provider a custom target borrows its command, environment
 * variable and setup file from. A custom target has no ProviderEntry of its
 * own, but every agent still needs a real bin to print, and most need a real
 * env var or config file shape too — this is where those come from instead.
 *
 * An agent with exactly one provider has only one thing to borrow, so that
 * one is used regardless of the wire format chosen: it is a best-effort
 * template, not a promise, and a mismatch is worth a note, not a dead end.
 * An agent with more than one provider picks by matching the chosen wire
 * format against each provider's `customTemplateFor` tags — and only that:
 * an untagged provider is untagged on purpose (see the field's own doc,
 * above), so a format with no exact match returns `undefined` rather than
 * borrowing an unrelated provider's command. `resolveCustomTarget` already
 * degrades honestly when this returns nothing — a bare command, no setup
 * file, no borrowed notes — which is the correct outcome here, not a bug to
 * paper over.
 */
function findCustomTemplate(
  agent: AgentEntry,
  renderer: RendererId
): ProviderEntry | undefined {
  const providers = agent.providers ?? [];
  if (providers.length <= 1) return providers[0];
  return providers.find((p) => p.customTemplateFor?.includes(renderer));
}

/**
 * The note shown whenever a custom target's wire format is "raw" — the
 * student said they were not sure, so every capture falls back to a JSON
 * dump. Every custom-target route says this the same way, so it is written
 * once here rather than copied into each one.
 */
const RAW_WIRE_FORMAT_NOTE =
  'You picked "not sure" for the wire format, so every capture falls ' +
  "back to a raw JSON dump instead of a fully rendered one. That is " +
  "not broken — it is just less readable. Run with --force and pick a " +
  "format once you know it, and the readable renderer takes over.";

/**
 * Whether a custom target for this agent and wire format needs a model
 * declared up front, rather than being able to start against a bare base
 * URL. The single source of truth both the wizard (config.ts, deciding
 * whether to bother discovering one) and resolveCustomTarget (deciding
 * whether to require one) consult, so a third agent that needs this only
 * ever means one edit, here.
 *
 * - OpenCode only needs one for its OpenAI-compatible route: that is the
 *   one built from an ephemeral provider with no catalogue entry to borrow
 *   a model from. Its Anthropic-compatible route borrows a real Anthropic
 *   provider instead, whose model names are real Anthropic model names.
 * - Pi needs one on every route: every one of its custom targets overrides
 *   an existing built-in provider (openai or anthropic), and that
 *   provider's built-in model names almost never exist on a self-hosted
 *   backend, whichever wire format was chosen for rendering.
 */
export function customTargetNeedsModel(
  agentId: string,
  renderer: RendererId
): boolean {
  if (agentId === "pi") return true;
  if (agentId === "opencode") return renderer === "openai";
  return false;
}

/**
 * Read the model the wizard asked for, or the error both routes that need
 * one return when it is missing — a remembered choice saved before this
 * field existed, say, or one edited by hand. Shared so the two routes that
 * call customTargetNeedsModel report the same shape of error, differing
 * only in which target they name.
 */
function resolveCustomModel(
  choice: AgentChoice,
  targetLabel: string
): { kind: "model"; model: string } | ResolveError {
  const model = choice.customModel?.trim();
  if (!model) {
    return {
      kind: "error",
      message: `${targetLabel} needs a model ID. Run with --force to choose again.`,
    };
  }
  return { kind: "model", model };
}

/**
 * Build a target from what the student typed, in place of a catalogue
 * lookup. The only facts on hand are the base URL and the wire format they
 * chose; everything else is borrowed from the closest matching catalogue
 * provider — see findCustomTemplate.
 */
function resolveCustomTarget(
  agent: AgentEntry,
  choice: AgentChoice,
  port: number,
  platform: NodeJS.Platform
): Resolution {
  if (!choice.customBaseUrl) {
    return {
      kind: "error",
      message: `${agent.label} needs a custom base URL. Run with --force to choose again.`,
    };
  }

  const upstream = parseUpstreamUrl(choice.customBaseUrl);
  if (!upstream) {
    return {
      kind: "error",
      message:
        `"${choice.customBaseUrl}" is not a usable base URL. It must start ` +
        `with http:// or https://, e.g. http://localhost:11434. Run with ` +
        `--force to choose again.`,
    };
  }

  const renderer: RendererId = choice.customRenderer ?? "raw";
  const template = findCustomTemplate(agent, renderer);
  const baseUrl = `http://localhost:${port}${template?.suffix ?? ""}`;

  if (agent.id === "opencode" && customTargetNeedsModel(agent.id, renderer)) {
    const modelResult = resolveCustomModel(
      choice,
      "OpenCode's custom OpenAI-compatible target"
    );
    if (modelResult.kind === "error") return modelResult;
    const { model } = modelResult;

    const providerId = "request-logger";
    const selectedModel = `${providerId}/${model}`;
    const config = JSON.stringify({
      model: selectedModel,
      small_model: selectedModel,
      provider: {
        [providerId]: {
          npm: "@ai-sdk/openai-compatible",
          name: "Request Logger",
          options: { baseURL: baseUrl },
          models: { [model]: { name: model } },
        },
      },
    });

    return {
      kind: "custom-target",
      agent: agent.id,
      agentLabel: agent.label,
      providerLabel: CUSTOM_LABEL,
      upstreamBaseUrl: upstreamBaseUrlWithPath(upstream),
      renderer,
      baseUrl,
      command:
        platform === "win32"
          ? `$env:OPENCODE_CONFIG_CONTENT = ${powerShellQuote(config)}; opencode`
          : `OPENCODE_CONFIG_CONTENT=${shellQuote(config)} opencode`,
      setup: [],
      notes: [
        "This temporary provider is merged with your existing OpenCode " +
          "configuration for this run only; your config file is not changed.",
      ],
      warnings: [],
    };
  }

  /**
   * Pi's custom target, on every wire format — unlike OpenCode's branch
   * above, which only fires for the OpenAI-compatible choice. Pi always
   * writes a models.json override for a custom base URL (see piModels), and
   * that override always replaces one of Pi's built-in providers, whose
   * built-in model names (gpt-4o, claude-*) almost never exist on a
   * self-hosted backend regardless of which wire format the student picked
   * for rendering. So a model is required here every time, not just for one
   * renderer.
   */
  if (agent.id === "pi" && customTargetNeedsModel(agent.id, renderer)) {
    const modelResult = resolveCustomModel(choice, "Pi's custom target");
    if (modelResult.kind === "error") return modelResult;
    const { model } = modelResult;

    // template is the anthropic or openai Pi provider entry (see
    // findCustomTemplate). Every renderer this branch can be reached with
    // ("openai", "anthropic", "raw") has a Pi provider tagged for it — see
    // the catalogue above — so this can only be missing if a future wire
    // format is added there without a matching Pi template.
    if (!template) {
      return {
        kind: "error",
        message:
          `Pi has no custom-target template for the "${renderer}" wire ` +
          `format. Run with --force to choose again.`,
      };
    }
    // template.id is the provider key Pi's built-in catalogue uses, which
    // is also the key this override replaces.
    const providerId = template.id;
    const notes = [
      `This models.json entry replaces Pi's built-in "${providerId}" model ` +
        "catalogue with the one model you selected, since Pi's built-in " +
        "model names almost never exist on a custom server.",
    ];
    if (renderer === "anthropic") {
      notes.push(
        "Model discovery only checks the OpenAI-style /v1/models listing " +
          "endpoint, which an Anthropic-compatible server often does not " +
          "expose. If discovery found nothing here and you typed the model " +
          "ID by hand, that is expected — it does not mean the ID is wrong."
      );
    }
    if (renderer === "raw") notes.push(RAW_WIRE_FORMAT_NOTE);

    return {
      kind: "custom-target",
      agent: agent.id,
      agentLabel: agent.label,
      providerLabel: CUSTOM_LABEL,
      upstreamBaseUrl: upstreamBaseUrlWithPath(upstream),
      renderer,
      baseUrl,
      command: buildCommand(template, baseUrl, { port, platform }),
      setup: [piModels(providerId, baseUrl, model)],
      notes,
      warnings: template.warnings ?? [],
    };
  }

  const notes = [
    `This command is built from ${agent.label}'s own setup pattern, since a ` +
      `custom target has no dedicated one of its own. If a note below assumes ` +
      `a specific login or account, it may not apply to your target.`,
    ...(template?.notes ?? []),
  ];
  if (renderer === "raw") notes.push(RAW_WIRE_FORMAT_NOTE);

  return {
    kind: "custom-target",
    agent: agent.id,
    agentLabel: agent.label,
    providerLabel: CUSTOM_LABEL,
    upstreamBaseUrl: upstreamBaseUrlWithPath(upstream),
    renderer,
    baseUrl,
    command: template
      ? buildCommand(template, baseUrl, { port, platform })
      : agent.id,
    setup: (template?.setup ?? []).map((file) => ({
      ...file,
      body: file.body.replace(/\{baseUrl\}/g, baseUrl),
    })),
    notes: notes.map((note) => note.replace(/\{baseUrl\}/g, baseUrl)),
    warnings: template?.warnings ?? [],
  };
}

/**
 * Turn a saved choice into everything the tool needs, or into a clear reason
 * why it cannot.
 *
 * Pure: no disk, no network, no clock. Give it the same choice, the same
 * port and the same platform and it gives back the same answer. `platform`
 * decides only the shell syntax of the printed command — POSIX `KEY=value
 * bin` everywhere except win32, where PowerShell needs `$env:KEY = 'value'`
 * statements instead (see withEnv). The caller reads `process.platform`
 * once and passes it in, the same way it already does for `port`.
 */
export function resolveChoice(
  choice: AgentChoice,
  options: { port: number; platform: NodeJS.Platform }
): Resolution {
  const agent = AGENTS.find((a) => a.id === choice.agent);

  // "Other" at either question means the same thing: the catalogue has no entry
  // for this student. Checked before the agent lookup, because "other" is not
  // an agent and must not read as an unknown one.
  if (choice.agent === OTHER_ID || choice.provider === OTHER_ID) {
    return {
      kind: "request",
      agentLabel: agent?.label ?? null,
      url: ISSUE_URL,
    };
  }

  if (!agent) {
    return {
      kind: "error",
      message:
        `Unknown agent "${choice.agent}". Run with --force to choose again. ` +
        `Known agents: ${AGENTS.map((a) => a.id).join(", ")}.`,
    };
  }

  if (!agent.providers) {
    return {
      kind: "refusal",
      agent: agent.id,
      agentLabel: agent.label,
      reason: agent.reason ?? "This agent cannot be logged.",
    };
  }

  // A custom target is resolved from what the student typed, not from a
  // catalogue lookup — either because they chose "Custom base URL" at the
  // provider question, or because every setup for this agent is custom
  // (alwaysCustom, e.g. OMP), which never shows that question at all.
  if (agent.alwaysCustom || choice.provider === CUSTOM_ID) {
    return resolveCustomTarget(agent, choice, options.port, options.platform);
  }

  // Templates are not resolvable: they carry no upstream host, so a target
  // built from one would forward nowhere. A choice naming one is a stale
  // save from before that provider became a template, and says so with the
  // list that can actually be picked. The single-provider shortcut below is
  // deliberately keyed on the total count, not the visible one: an agent
  // with one real route and two templates still asks, because "Custom base
  // URL" is a real second option there.
  const providers = visibleProviders(agent);

  let provider: ProviderEntry | undefined;
  if (agent.providers.length === 1) {
    // One provider, so the wizard never asked. Ignore anything saved.
    provider = agent.providers[0];
  } else if (choice.provider == null) {
    return {
      kind: "error",
      message:
        `${agent.label} can drive more than one model provider, so a provider ` +
        `must be chosen. Run with --force to choose again. Providers: ` +
        `${providers.map((p) => p.id).join(", ")}.`,
    };
  } else {
    provider = providers.find((p) => p.id === choice.provider);
    if (!provider) {
      return {
        kind: "error",
        message:
          `Unknown provider "${choice.provider}" for ${agent.label}. Run with ` +
          `--force to choose again. Providers: ` +
          `${providers.map((p) => p.id).join(", ")}.`,
      };
    }
  }

  // A MITM route has no base URL to print. Nothing is pointed at this proxy
  // by URL there — the agent reaches it through HTTPS_PROXY and sends
  // CONNECT — so this is left empty rather than filled with the listening
  // address, which would read like something to paste somewhere.
  const baseUrl = provider.mitm
    ? ""
    : `http://localhost:${options.port}${provider.suffix ?? ""}`;

  return {
    kind: "target",
    agent: agent.id,
    agentLabel: agent.label,
    provider: provider.id,
    providerLabel: provider.label,
    upstreamHost: provider.upstreamHost,
    renderer: provider.renderer,
    baseUrl,
    command: buildCommand(provider, baseUrl, options),
    setup: (provider.setup ?? []).map((file) => ({
      ...file,
      body: file.body.replace(/\{baseUrl\}/g, baseUrl),
    })),
    notes: (provider.notes ?? []).map((note) =>
      note.replace(/\{baseUrl\}/g, baseUrl)
    ),
    warnings: provider.warnings ?? [],
    mitm: provider.mitm === true,
    mitmHosts: provider.mitmHosts,
  };
}
