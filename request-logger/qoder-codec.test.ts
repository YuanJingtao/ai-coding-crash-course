import { describe, it, expect } from "vitest";
import {
  QODER_ALPHABET,
  QODER_PAD,
  decodeQoderBody,
  encodeQoderBody,
  swapOuterThird,
} from "./qoder-codec";

/**
 * (plaintext, on-the-wire body) pairs recorded from qodercli's own encoder —
 * the WASM module `qoder_auth_wasm_bg.wasm` embedded in qodercli 1.1.46,
 * driven with chosen plaintext. These are the ground truth everything below is
 * checked against; nothing in this file was produced by the code it tests.
 */
const GOLDEN: Array<[string, string]> = [
  ["", ""],
  ["a", "$p$#"],
  ["ab", "$SB#"],
  ["abc", "MSK#"],
  ["abcd", "$$KMD_#S"],
  ['{"a":1}', "ep$$BMn%mYKi"],
  [
    '{"messages":[{"role":"system","content":"You are Qoder."}]}',
    "KDuka&#xKLBggbDHFYG*KWxxw$ByBEjQNkCLu,BrBOjbuECLuEp*l*mYKtDxj^#SJLNYBySkr*NOWrD,",
  ],
  ["héllo wörld — 中文 🎉", "tQ)PZBvoeMnz$EKrDoR*&Kp&QG*PVl)uH%bBZeRt"],
];

const encode = encodeQoderBody;

/** Deterministic pseudo-random bytes, so a failure is reproducible. */
function seededText(seed: number, length: number): string {
  let state = seed;
  const next = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state;
  };
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(0x20 + (next() % 0x5f));
  }
  return out;
}

describe("qoder alphabet", () => {
  it("has 64 symbols, all distinct", () => {
    expect(QODER_ALPHABET).toHaveLength(64);
    expect(new Set(QODER_ALPHABET).size).toBe(64);
  });

  it("keeps the pad character out of the alphabet, so a pad is never a value", () => {
    expect(QODER_ALPHABET).not.toContain(QODER_PAD);
  });
});

describe("swapOuterThird", () => {
  it("is its own inverse, which is why one function serves both directions", () => {
    for (const [, encoded] of GOLDEN) {
      expect(swapOuterThird(swapOuterThird(encoded))).toBe(encoded);
    }
  });

  it("moves the last floor(L/3) characters to the front and the first to the end", () => {
    expect(swapOuterThird("ABCDEFGH")).toBe("GHCDEFAB"); // L=8, a=2
    expect(swapOuterThird("ABCD")).toBe("DBCA"); // L=4, a=1
    expect(swapOuterThird("ABC")).toBe("CBA"); // L=3, a=1
    expect(swapOuterThird("")).toBe("");
  });
});

describe("encodeQoderBody", () => {
  it("reproduces every body qodercli's WASM encoder produced", () => {
    for (const [plain, encoded] of GOLDEN) {
      expect(encode(plain)).toBe(encoded);
    }
  });
});

describe("decodeQoderBody", () => {
  it("reads back every recorded body", () => {
    for (const [plain, encoded] of GOLDEN) {
      expect(decodeQoderBody(encoded)).toBe(plain);
    }
  });

  it("round-trips every length mod 3, so no padding case is missed", () => {
    for (let length = 0; length <= 40; length++) {
      const plain = seededText(length + 1, length);
      expect(decodeQoderBody(encode(plain))).toBe(plain);
    }
  });

  it("round-trips multi-byte UTF-8, which is what a Chinese prompt is made of", () => {
    const plain = "你是一个 AI 编程助手。🎉\n\ttab and \\ backslash";
    expect(decodeQoderBody(encode(plain))).toBe(plain);
  });

  it("round-trips a body the size of a real capture", () => {
    // A live qodercli inference body was 285 KB. The decoder runs once per
    // request, so it has to cope with that without anything quadratic.
    const plain = seededText(7, 300_000);
    const encoded = encode(plain);
    expect(encoded).toHaveLength(4 * Math.ceil(plain.length / 3));
    expect(decodeQoderBody(encoded)).toBe(plain);
  });

  it("round-trips pseudo-random bodies, not just the ones chosen above", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const plain = seededText(seed, seed * 37);
      expect(decodeQoderBody(encode(plain))).toBe(plain);
    }
  });

  it("rejects a symbol outside the alphabet instead of decoding it to something", () => {
    expect(() => decodeQoderBody("ep$$BMn%mYK~")).toThrow(/~/);
  });

  it("rejects an ordinary JSON body, which is not encoded at all", () => {
    // render.ts checks for this before calling in; this is the backstop that
    // makes the mistake loud rather than silent if a caller forgets.
    expect(() => decodeQoderBody('{"a":1}')).toThrow();
  });
});
