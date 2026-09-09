import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import { decodeRequestBody, renderMarkdown } from "./render";
import { encodeQoderBody } from "./qoder-codec";

const BASE = {
  timestamp: "2026-08-06T10:00:00.000Z",
  method: "POST",
  statusCode: 200,
  headers: {} as Record<string, string | string[] | undefined>,
};

function body(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value));
}

// ---------------------------------------------------------------------------
// Body decoding
// ---------------------------------------------------------------------------

describe("decodeRequestBody", () => {
  it("leaves an uncompressed body alone", () => {
    expect(decodeRequestBody(Buffer.from("hello"), undefined)).toBe("hello");
  });

  it("leaves a body alone when the encoding is identity", () => {
    expect(decodeRequestBody(Buffer.from("hello"), "identity")).toBe("hello");
  });

  it("decodes a zstd body", () => {
    const compressed = zlib.zstdCompressSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "zstd")).toBe("hello");
  });

  it("decodes a gzip body", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "gzip")).toBe("hello");
  });

  it("ignores the case of the encoding", () => {
    const compressed = zlib.gzipSync(Buffer.from("hello"));
    expect(decodeRequestBody(compressed, "GZIP")).toBe("hello");
  });

  it("fails loudly, instead of silently showing raw bytes as text, when the body will not decode", () => {
    const out = decodeRequestBody(Buffer.from("not compressed"), "zstd");
    expect(out).toContain("COULD NOT DECODE");
    expect(out).toContain("not compressed");
  });

  it("fails loudly, naming the encoding, for content-encodings it does not know", () => {
    const out = decodeRequestBody(Buffer.from("hello"), "compress");
    expect(out).toContain("COULD NOT DECODE");
    expect(out).toContain("compress");
  });

  it("fails loudly, naming the Node version, when the runtime has no zstd support", () => {
    const original = (zlib as any).zstdDecompressSync;
    delete (zlib as any).zstdDecompressSync;
    try {
      const compressed = zlib.zstdCompressSync(Buffer.from("hello"));
      const out = decodeRequestBody(compressed, "zstd");
      expect(out).toContain("COULD NOT DECODE");
      expect(out).toContain("zstd");
      expect(out).toContain(process.version);
    } finally {
      (zlib as any).zstdDecompressSync = original;
    }
  });
});

describe("renderMarkdown with a compressed body", () => {
  it("shows the decoded request", () => {
    const request = {
      model: "gpt-5.1",
      instructions: "You are a careful assistant.",
      input: "hello",
    };
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(body(request)),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("You are a careful assistant.");
  });

  it("finds the model in a compressed body", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Pi (ChatGPT)",
      renderer: "openai",
      path: "/backend-api/codex/responses",
      requestBody: zlib.zstdCompressSync(body({ model: "gpt-5.1", input: "hi" })),
      requestEncoding: "zstd",
      responseRaw: "",
    });
    expect(out).toContain("**model**: gpt-5.1");
  });
});

// ---------------------------------------------------------------------------
// Anthropic — the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for Anthropic", () => {
  const request = {
    model: "claude-sonnet-4-5",
    system: "You are Claude Code.",
    tools: [
      { name: "Read", description: "Read a file", input_schema: { type: "object" } },
    ],
    messages: [{ role: "user", content: "hello" }],
  };

  const out = renderMarkdown({
    ...BASE,
    agent: "Claude Code",
    renderer: "anthropic",
    path: "/v1/messages",
    requestBody: body(request),
    responseRaw:
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n' +
      'data: {"type":"content_block_delta","index":0,"delta":{"text":"hi"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Claude Code.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### Read");
  });

  it("shows the message", () => {
    expect(out).toContain('<message index="1" role="user">');
  });

  it("names the agent in the meta block", () => {
    expect(out).toContain("**agent**: Claude Code");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// OpenAI — the existing renderer must keep working
// ---------------------------------------------------------------------------

describe("renderMarkdown for OpenAI", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Codex",
    renderer: "openai",
    path: "/v1/responses",
    requestBody: body({
      model: "gpt-5.1",
      instructions: "You are Codex.",
      tools: [{ type: "function", name: "shell", parameters: { type: "object" } }],
      input: [{ type: "message", role: "user", content: "hello" }],
    }),
    responseRaw:
      'data: {"type":"response.output_text.delta","delta":"hi"}\n' +
      'data: {"type":"response.completed","response":{"status":"completed"}}\n',
  });

  it("shows the system prompt", () => {
    expect(out).toContain("You are Codex.");
  });

  it("shows the tool name", () => {
    expect(out).toContain("### shell");
  });

  it("reassembles the streamed reply", () => {
    expect(out).toContain("hi");
  });
});

// ---------------------------------------------------------------------------
// "raw" — the explicit fallback for a custom target with no known wire format
// ---------------------------------------------------------------------------

describe('renderMarkdown for the "raw" renderer', () => {
  // Deliberately shaped like an OpenAI /responses request, so a test failure
  // here would show the bug this renderer exists to prevent: "raw" quietly
  // falling through to the OpenAI parser instead of the generic JSON dump.
  const request = {
    model: "some-local-model",
    instructions: "You are a careful assistant.",
    input: [{ type: "message", role: "user", content: "hello" }],
  };

  const out = renderMarkdown({
    ...BASE,
    agent: "OMP",
    renderer: "raw",
    path: "/v1/chat/completions",
    requestBody: body(request),
    responseRaw: JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
  });

  it("dumps the request as plain JSON, not through the OpenAI parser", () => {
    expect(out).not.toContain("<system-prompt>");
    expect(out).not.toContain("<messages>");
  });

  it("still shows the request content somewhere in the JSON dump", () => {
    expect(out).toContain("You are a careful assistant.");
  });

  it("dumps a non-streaming response as plain JSON, not through the OpenAI parser", () => {
    expect(out).not.toContain("<assistant-text>");
    expect(out).toContain('"content": "hi"');
  });

  it("still finds the model name, because that reading does not depend on the renderer", () => {
    expect(out).toContain("**model**: some-local-model");
  });

  it("dumps each SSE event as its own JSON block instead of reconstructing assistant text", () => {
    const streamed = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/v1/chat/completions",
      requestBody: body(request),
      responseRaw:
        'data: {"choices":[{"delta":{"content":"hi"}}]}\n' +
        'data: {"choices":[{"delta":{"content":" there"}}]}\n',
    });
    expect(streamed).not.toContain("<assistant-text>");
    expect(streamed).toContain('"content": "hi"');
    expect(streamed).toContain('"content": " there"');
  });

  it("falls back to the untouched raw text for a stream it cannot parse at all", () => {
    // Stands in for Ollama's NDJSON: bare JSON objects, one per line, with no
    // `data:` prefix — genuinely different from SSE, and out of scope here.
    // The one promise this renderer makes for that shape is "not broken".
    const ndjson =
      '{"model":"llama3","message":{"content":"hi"}}\n' +
      '{"model":"llama3","message":{"content":" there"},"done":true}\n';
    const out = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/api/chat",
      requestBody: body(request),
      responseRaw: ndjson,
    });
    expect(out).toContain('"content":"hi"');
  });

  it("does not treat an unparseable body as raw JSON, and falls back to raw text", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "OMP",
      renderer: "raw",
      path: "/v1/chat/completions",
      requestBody: Buffer.from("not json at all"),
      responseRaw: "",
    });
    expect(out).toContain("not json at all");
  });
});

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

const GEMINI_REQUEST = {
  systemInstruction: {
    role: "user",
    parts: [{ text: "You are the Gemini CLI." }],
  },
  contents: [
    { role: "user", parts: [{ text: "list my files" }] },
    {
      role: "model",
      parts: [{ functionCall: { name: "list_directory", args: { path: "." } } }],
    },
    {
      role: "user",
      parts: [
        {
          functionResponse: {
            name: "list_directory",
            response: { output: "one.ts" },
          },
        },
      ],
    },
  ],
  tools: [
    {
      functionDeclarations: [
        {
          name: "list_directory",
          description: "List the files in a directory",
          parametersJsonSchema: { type: "object", properties: {} },
        },
      ],
    },
  ],
  generationConfig: { temperature: 0, thinkingConfig: { includeThoughts: true } },
};

describe("renderMarkdown for Gemini with an API key", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: "",
  });

  it("shows the system prompt, which sits beside the messages", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("puts the system prompt in its own section", () => {
    expect(out).toContain("<system-prompt>");
  });

  it("shows the tool name from inside the double nesting", () => {
    expect(out).toContain("### list_directory");
  });

  it("shows the tool description", () => {
    expect(out).toContain("List the files in a directory");
  });

  it("shows the user message", () => {
    expect(out).toContain("list my files");
  });

  it("uses the model role, not assistant", () => {
    expect(out).toContain('role="model"');
    expect(out).not.toContain('role="assistant"');
  });

  it("shows a tool call", () => {
    expect(out).toContain('<tool-use name="list_directory"');
  });

  it("shows a tool result", () => {
    expect(out).toContain('<tool-result name="list_directory"');
  });

  it("shows the sampling settings from the nested config", () => {
    expect(out).toContain("**temperature**: 0");
  });

  it("takes the model name from the URL, because the body has none", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for Gemini with a Google login", () => {
  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1internal:streamGenerateContent",
    requestBody: body({
      model: "gemini-2.5-pro",
      project: "some-project",
      request: GEMINI_REQUEST,
    }),
    responseRaw: "",
  });

  it("unwraps the outer envelope and shows the system prompt", () => {
    expect(out).toContain("You are the Gemini CLI.");
  });

  it("unwraps the outer envelope and shows the tools", () => {
    expect(out).toContain("### list_directory");
  });

  it("unwraps the outer envelope and shows the messages", () => {
    expect(out).toContain("list my files");
  });

  it("takes the model name from the body on this route", () => {
    expect(out).toContain("**model**: gemini-2.5-pro");
  });
});

describe("renderMarkdown for a Gemini response", () => {
  const stream =
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[{"text":" there"}]}}]}\n' +
    'data: {"candidates":[{"content":{"role":"model","parts":[]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":12}}\n';

  const out = renderMarkdown({
    ...BASE,
    agent: "Gemini CLI",
    renderer: "gemini",
    path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    requestBody: body(GEMINI_REQUEST),
    responseRaw: stream,
  });

  it("joins the reply text across events", () => {
    expect(out).toContain("Hello there");
  });

  it("shows the finish reason", () => {
    expect(out).toContain("**finish reason**: STOP");
  });

  it("shows the usage", () => {
    expect(out).toContain("totalTokenCount");
  });

  it("unwraps the response envelope used by the Google login route", () => {
    const wrapped = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1internal:streamGenerateContent",
      requestBody: body({ request: GEMINI_REQUEST }),
      responseRaw:
        'data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Wrapped"}]},"finishReason":"STOP"}]}}\n',
    });
    expect(wrapped).toContain("Wrapped");
  });

  it("separates thinking from the reply", () => {
    const thought = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      path: "/v1beta/models/gemini-2.5-pro:streamGenerateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw:
        'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"pondering","thought":true},{"text":"answer"}]}}]}\n',
    });
    expect(thought).toContain("<thinking>");
    expect(thought).toContain("pondering");
  });
});

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

describe("renderMarkdown header redaction", () => {
  it("hides the authorization header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { authorization: "Bearer secret-token" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-token");
    expect(out).toContain("[REDACTED]");
  });

  it("hides the x-goog-api-key header", () => {
    const out = renderMarkdown({
      ...BASE,
      agent: "Gemini CLI",
      renderer: "gemini",
      headers: { "x-goog-api-key": "secret-goog-key" },
      path: "/v1beta/models/gemini-2.5-pro:generateContent",
      requestBody: body(GEMINI_REQUEST),
      responseRaw: "",
    });
    expect(out).not.toContain("secret-goog-key");
    expect(out).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// Qoder
//
// Qoder's subscription route encodes its request body before sending it, so
// these tests build their fixtures with the encoder qodercli itself uses (see
// qoder-codec.ts) rather than writing JSON. The field names come from reading
// the builder in qodercli 1.1.46.
// ---------------------------------------------------------------------------

const QODER_SYSTEM = "You are Qoder, an interactive coding agent.";

/** The flat snake_case body the encoded subscription route sends. */
const QODER_REQUEST = {
  request_id: "1f0c1a7e-0000-4000-8000-000000000001",
  request_set_id: "1f0c1a7e-0000-4000-8000-000000000002",
  chat_record_id: "1f0c1a7e-0000-4000-8000-000000000001",
  session_id: "session-1",
  stream: true,
  chat_task: "FREE_INPUT",
  chat_context: {
    text: "read /tmp/x",
    features: [],
    chatPrompt: "",
    imageUrls: null,
    extra: {
      context: [],
      originalContent: "read /tmp/x",
      modelConfig: { key: "qwen3-max", is_reasoning: false },
    },
  },
  is_reply: true,
  is_retry: false,
  source: 1,
  version: "3",
  agent_id: "agent_common",
  task_id: "common",
  session_type: "qodercli",
  aliyun_user_type: "",
  model_config: {
    key: "qwen3-max",
    display_name: "Qwen3 Max",
    model: "",
    format: "openai",
    is_vl: false,
    is_reasoning: true,
    // Empty on the subscription route, but this field is where a BYOK key
    // would land, so the renderer has to treat it as a secret either way.
    api_key: "sk-live-do-not-print-me",
    url: "",
    source: "system",
    max_input_tokens: 262144,
  },
  system: QODER_SYSTEM,
  messages: [
    // Qoder sends the system prompt twice: once as the top-level `system`
    // string and once as a leading system message.
    { role: "system", content: QODER_SYSTEM },
    {
      role: "user",
      content: "read /tmp/x",
      contents: [{ type: "text", text: "read /tmp/x" }],
    },
    {
      role: "assistant",
      content: "",
      reasoning_content: "The user wants a file read.",
      tool_calls: [
        {
          id: "call_1",
          type: "function",
          index: 0,
          function: { name: "Read", arguments: '{"file_path":"/tmp/x"}' },
        },
      ],
    },
    { role: "tool", content: "the file contents", tool_call_id: "call_1" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "Read",
        description: "Read a file from disk",
        parameters: { type: "object", properties: { file_path: { type: "string" } } },
      },
    },
  ],
  parameters: {
    temperature: 0.7,
    max_tokens: 8192,
    reasoning_effort: "medium",
    enable_thinking: true,
    tool_choice: "auto",
  },
  business: {
    id: "b1",
    name: "chat",
    begin_at: 1700000000,
    product: "qoder",
    version: "1.1.46",
    type: "cli",
    stage: "chat",
  },
};

function qoderBody(value: unknown): Buffer {
  return Buffer.from(encodeQoderBody(JSON.stringify(value)));
}

function renderQoder(overrides: Partial<Parameters<typeof renderMarkdown>[0]> = {}) {
  return renderMarkdown({
    ...BASE,
    agent: "Qoder",
    renderer: "qoder",
    path: "/algo/api/v2/service/pro/sse/agent_chat_generation",
    requestBody: qoderBody(QODER_REQUEST),
    responseRaw: "",
    ...overrides,
  });
}

describe("renderMarkdown for Qoder", () => {
  const out = renderQoder();

  it("decodes the body and shows the system prompt verbatim", () => {
    expect(out).toContain("<system-prompt>");
    expect(out).toContain(QODER_SYSTEM);
  });

  it("does not show the system prompt twice, though Qoder sends it twice", () => {
    const times = out.split(QODER_SYSTEM).length - 1;
    expect(times).toBe(1);
  });

  it("names the wire format in the meta block", () => {
    expect(out).toContain("**wire format**: qoder");
  });

  it("finds the model in model_config, which is where Qoder puts it", () => {
    expect(out).toContain("**model**: qwen3-max");
  });

  it("hides the API key in the body, not just the ones in headers", () => {
    expect(out).not.toContain("sk-live-do-not-print-me");
    expect(out).toContain("[REDACTED]");
  });

  it("shows the tool name and its schema", () => {
    expect(out).toContain("### Read");
    expect(out).toContain("Read a file from disk");
    expect(out).toContain('"file_path"');
  });

  it("shows the user message, renumbered now the duplicate system message is gone", () => {
    expect(out).toContain('<message index="1" role="user">');
    expect(out).toContain("read /tmp/x");
  });

  it("shows the assistant's reasoning as thinking, and its tool call", () => {
    expect(out).toContain("<thinking>");
    expect(out).toContain("The user wants a file read.");
    expect(out).toContain('<tool-use name="Read" id="call_1">');
  });

  it("shows the tool result against the call it answers", () => {
    expect(out).toContain('<tool-result tool-call-id="call_1"');
    expect(out).toContain("the file contents");
  });

  it("shows the sampling parameters", () => {
    expect(out).toContain("**temperature**: 0.7");
    expect(out).toContain("**reasoning_effort**: medium");
  });

  it("keeps the fields it has no section for, rather than dropping them", () => {
    // The design rule for this tool is verbatim and complete. session_type and
    // business are not model input, but they were sent, so they are shown.
    expect(out).toContain("<other-fields>");
    expect(out).toContain("qodercli");
    expect(out).toContain("1.1.46");
  });
});

describe("renderMarkdown for Qoder — bodies it must not misread", () => {
  it("fails loudly when an encoded body will not decode", () => {
    // A Qoder release that changes its encoder is the realistic way this
    // happens, and a page of plausible-looking gibberish would be worse than
    // an error: the whole point of the tool is that what it shows was sent.
    const out = renderQoder({
      requestBody: Buffer.from("~~~~not a qoder body~~~~"),
    });
    expect(out).toContain("COULD NOT DECODE");
  });

  it("fails loudly when a body decodes but is not the JSON it should be", () => {
    const out = renderQoder({
      requestBody: Buffer.from(encodeQoderBody("not json at all")),
    });
    expect(out).toContain("COULD NOT DECODE");
  });

  it("leaves a body that is already JSON alone", () => {
    // `Encode=1` is per endpoint, so not every call Qoder makes is encoded.
    // Re-decoding a plaintext body would turn it into noise.
    const out = renderQoder({ requestBody: body(QODER_REQUEST) });
    expect(out).toContain(QODER_SYSTEM);
  });

  it("reads Qoder's plaintext OpenAI-shaped route with the OpenAI renderer", () => {
    // The newer model-server transport posts an ordinary chat/completions body
    // to /model/v1/chat/completions, with `model` at the top level and no
    // model_config. Same renderer id, different shape.
    const out = renderQoder({
      path: "/model/v1/chat/completions",
      requestBody: body({
        model: "qwen3-max",
        messages: [
          { role: "system", content: "Plain route system prompt." },
          { role: "user", content: "hi" },
        ],
        stream: true,
      }),
    });
    expect(out).toContain("Plain route system prompt.");
    expect(out).toContain("**model**: qwen3-max");
  });

  it("shows patches, and says they are edits rather than content", () => {
    // Qoder's patches are edit directives applied to the system prompt, not
    // references standing in for message text. Rendering them as though they
    // were the prompt would be a lie about what was sent.
    const out = renderQoder({
      requestBody: qoderBody({
        ...QODER_REQUEST,
        patches: {
          "": [{ action: "edit_system_prompt", content: "Be terse." }],
        },
      }),
    });
    expect(out).toContain("<patches>");
    expect(out).toContain("Be terse.");
    expect(out).toMatch(/edit/i);
  });

  it("placeholders an image part instead of printing its base64", () => {
    const out = renderQoder({
      requestBody: qoderBody({
        ...QODER_REQUEST,
        messages: [
          {
            role: "user",
            content: "what is this",
            contents: [
              { type: "text", text: "what is this" },
              { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
            ],
          },
        ],
      }),
    });
    expect(out).toContain("[image");
    expect(out).toContain(".request.txt");
  });
});

describe("renderMarkdown for Qoder — the streamed reply", () => {
  it("reassembles the OpenAI-shaped stream", () => {
    const out = renderQoder({
      responseRaw:
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"pon"}}]}\n' +
        'data: {"object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"g"},"finish_reason":"stop"}]}\n' +
        'data: {"object":"chat.completion.chunk","choices":[],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n' +
        "data: [DONE]\n",
    });
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("pong");
    expect(out).toContain("**finish reason**: stop");
    expect(out).toContain("**usage**");
  });

  it("shows reasoning_content from the stream as thinking", () => {
    const out = renderQoder({
      responseRaw:
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"think"}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"ing"}}]}\n' +
        'data: {"choices":[{"index":0,"delta":{"content":"answer"},"finish_reason":"stop"}]}\n',
    });
    expect(out).toContain("<thinking>");
    expect(out).toContain("thinking");
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("answer");
  });
});

// ---------------------------------------------------------------------------
// Qoder against real traffic
//
// The fixtures above were derived from reading qodercli's builder. These come
// from a live 1.1.47 run through the proxy, and each one is a place where the
// real thing differed from what the source suggested.
// ---------------------------------------------------------------------------

describe("renderMarkdown for Qoder — redaction, as real traffic needs it", () => {
  it("hides the cosy-* credentials, which are not named like one", () => {
    // Both arrived in plaintext on a real request, alongside a redacted
    // `authorization`. Neither name contains "api key" or "token" as a word,
    // and both are credentials: one is a signed key, one identifies the
    // machine to Qoder's account service.
    const out = renderQoder({
      headers: {
        authorization: "Bearer real-bearer-value",
        "cosy-key": "cosy-secret-value",
        "cosy-machinetoken": "89065767-694d-42fb-a8ac-8a1da7bb70e7",
      },
    });
    expect(out).not.toContain("real-bearer-value");
    expect(out).not.toContain("cosy-secret-value");
    expect(out).not.toContain("89065767-694d-42fb-a8ac-8a1da7bb70e7");
  });

  it("still shows max_input_tokens, a limit rather than a secret", () => {
    // The flip side of the same rule. A substring match on "token" hid this
    // from the model-config block, where it is the one number worth reading:
    // it is the context window the model was called with.
    const out = renderQoder();
    expect(out).toContain("**max_input_tokens**: 262144");
  });

  it("still shows the identifiers that are not credentials", () => {
    const out = renderQoder({
      headers: {
        "cosy-machineid": "machine-id-value",
        "cosy-organization-id": "b1731805-0000-0000-0000-000000000000",
        traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
      },
    });
    expect(out).toContain("machine-id-value");
    expect(out).toContain("b1731805-0000-0000-0000-000000000000");
    expect(out).toContain("4bf92f3577b34da6a3ce929d0e0e4736");
  });
});

describe("renderMarkdown — a secret value under a name that is not one", () => {
  it("hides the value everywhere, not only on the line that named it", () => {
    // Real 1.1.47 headers: cosy-machineid and cosy-machinetoken carry the same
    // string. Redacting the second by name left the first printing it in full,
    // so what a secret-named header held is scrubbed from the whole document.
    const shared = "89065767-694d-42fb-a8ac-8a1da7bb70e7";
    const out = renderQoder({
      headers: { "cosy-machinetoken": shared, "cosy-machineid": shared },
    });
    expect(out).not.toContain(shared);
    expect(out).toContain("cosy-machinetoken: [REDACTED]");
  });

  it("scrubs the credential out of an authorization scheme prefix too", () => {
    // What leaks into a body is the token, not the word Bearer in front of it.
    const token = "A1B2C3D4E5F6G7H8I9J0K1L2";
    const out = renderQoder({
      headers: { authorization: `Bearer ${token}` },
      requestBody: qoderBody({ ...QODER_REQUEST, note: `signed with ${token}` }),
    });
    expect(out).not.toContain(token);
  });

  it("leaves a short value alone, since scrubbing it would rewrite the body", () => {
    // Below this length a secret-named value could be an ordinary word, and
    // replacing every occurrence of one would corrupt what was actually sent.
    // The header line itself is still hidden, which is all the name proves.
    const out = renderQoder({
      headers: { "x-api-key": "abc" },
      requestBody: qoderBody({ ...QODER_REQUEST, note: "abc is not a credential" }),
    });
    expect(out).toContain("x-api-key: [REDACTED]");
    expect(out).toContain("abc is not a credential");
  });
});

describe("renderMarkdown for Qoder — a body with no top-level system", () => {
  const withoutTopLevelSystem = () =>
    renderQoder({
      requestBody: qoderBody({ ...QODER_REQUEST, system: undefined }),
    });

  it("reads the prompt out of the leading system message instead", () => {
    // Real 1.1.47 traffic carries no top-level `system` at all. Rendering the
    // prompt as an ordinary message left it technically present and
    // practically invisible, since <system-prompt> is where it is looked for.
    expect(withoutTopLevelSystem()).toContain("<system-prompt>");
    expect(withoutTopLevelSystem()).toContain(QODER_SYSTEM);
  });

  it("still shows it exactly once, not once per place it could come from", () => {
    const out = withoutTopLevelSystem();
    expect(out.split(QODER_SYSTEM).length - 1).toBe(1);
  });

  it("leaves a leading message that is not a system prompt alone", () => {
    const out = renderQoder({
      requestBody: qoderBody({
        ...QODER_REQUEST,
        system: undefined,
        messages: [
          { role: "user", content: "first user turn" },
          { role: "assistant", content: "first answer" },
        ],
      }),
    });
    expect(out).not.toContain("<system-prompt>");
    expect(out).toContain('<message index="1" role="user">');
    expect(out).toContain("first user turn");
  });
});

describe("renderMarkdown for Qoder — the envelope its stream really arrives in", () => {
  /** One SSE line as qodercli's subscription route sends it. */
  function envelope(chunk: unknown): string {
    return (
      `data:${JSON.stringify({
        headers: { "Content-Type": ["application/json"] },
        body: JSON.stringify(chunk),
        statusCodeValue: 200,
        statusCode: "OK",
      })}\n`
    );
  }

  it("unwraps each event and reassembles the answer", () => {
    const out = renderQoder({
      responseRaw:
        envelope({
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "", reasoning_content: "The user said" } }],
        }) +
        envelope({
          object: "chat.completion.chunk",
          choices: [{ index: 0, delta: { content: "pong" }, finish_reason: "stop" }],
        }) +
        envelope({
          object: "chat.completion.chunk",
          choices: [],
          usage: { prompt_tokens: 26933, completion_tokens: 97, credits: 2.91 },
        }) +
        'data:{"body":"[DONE]","statusCodeValue":200,"statusCode":"OK"}\n' +
        "\nevent:finish\n" +
        'data:{"firstTokenDuration":1667,"totalDuration":3388,"serverDuration":161}\n',
    });
    expect(out).toContain("<thinking>");
    expect(out).toContain("The user said");
    expect(out).toContain("<assistant-text>");
    expect(out).toContain("pong");
    expect(out).toContain("**finish reason**: stop");
    expect(out).toContain("26933");
  });

  it("drops an event whose body will not parse, as the other renderers do", () => {
    // Not a crash and not a page of escaped junk: the events this cannot read
    // are skipped, which leaves the same fallback message an empty stream
    // gets. The raw stream is still in .response.txt.
    const out = renderQoder({
      responseRaw:
        'data:{"body":"not json","statusCodeValue":200,"statusCode":"OK"}\n' +
        'data:{"body":"also not json","statusCodeValue":500,"statusCode":"ERROR"}\n',
    });
    expect(out).toContain("no content decoded");
  });
});
