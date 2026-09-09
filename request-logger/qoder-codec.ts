/**
 * qoder-codec.ts — reads the request body qodercli puts on the wire.
 *
 * Qoder's default subscription route offers no base-URL override, so the only
 * way to see its requests at all is to stand in the middle of its TLS
 * connection. Doing that gets you the body, but not a readable one: qodercli
 * passes every such body through an encoder in a WASM module
 * (`qoder_auth_wasm_bg.wasm`, embedded base64 in the binary) and marks the call
 * with `Encode=1` in the URL.
 *
 * That encoder is not encryption. It is standard base64 over a private
 * 64-symbol alphabet, with `$` as the pad, followed by a swap of the outer
 * `floor(L/3)` characters. There is no key: the output is identical under a
 * different machine ID, a different client version, a different clock and a
 * pinned RNG, and it is exactly `4*ceil(n/3)` long, so there is no nonce and no
 * MAC in it either. The WASM module exports no decoder — qodercli only ever
 * encodes, so it never needed one — which is why this file exists.
 *
 * Derived against qodercli 1.1.45, 1.1.46 and 1.1.47. The embedded WASM is
 * byte-identical across all three, so the alphabet below is not tied to a
 * version. It is still Qoder's to change, which is why decodeQoderBody refuses
 * a symbol it does not know rather than decoding it to something.
 */

export const QODER_ALPHABET =
  "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";

/** Stands in for base64's `=`. Never also a value — see the test. */
export const QODER_PAD = "$";

/**
 * Symbol -> 6-bit value, indexed by char code. Every symbol is printable ASCII,
 * so a 128-entry table covers the whole alphabet and a body decodes without
 * allocating anything per character — worth it, because a real qodercli
 * inference body is a few hundred KB and this runs once per request.
 */
const VALUES = new Int8Array(128).fill(-1);
for (let i = 0; i < QODER_ALPHABET.length; i++) {
  VALUES[QODER_ALPHABET.charCodeAt(i)] = i;
}

/**
 * Swap the first `floor(L/3)` characters with the last, leaving the middle in
 * place. This is the whole of Qoder's shuffle, and it is its own inverse: the
 * same call both undoes the encoder's rearrangement and would perform it, which
 * is why one function is enough here.
 */
export function swapOuterThird(text: string): string {
  const outer = Math.floor(text.length / 3);
  return (
    text.slice(text.length - outer) +
    text.slice(outer, text.length - outer) +
    text.slice(0, outer)
  );
}

/**
 * Turn an encoded qodercli request body back into the JSON text it started as.
 *
 * Throws on a symbol outside the alphabet rather than decoding it to something
 * plausible: a body that does not decode is far more likely to mean Qoder
 * changed its encoder than to mean the bytes are subtly different, and guessing
 * here would produce a readable-looking document that is not what was sent.
 * render.ts turns that throw into a warning ahead of the untouched body.
 */
export function decodeQoderBody(encoded: string): string {
  const natural = swapOuterThird(encoded);

  // The pad only ever trails, and only ever stands for bytes that are not
  // there, so it is dropped before the bit loop rather than decoded.
  let end = natural.length;
  while (end > 0 && natural[end - 1] === QODER_PAD) end--;

  // base64's fixed ratio, computed up front so the output is one allocation:
  // three bytes per whole group of four symbols, then one byte for a leftover
  // pair and two for a leftover triple. A single leftover symbol is not valid
  // base64 and contributes nothing.
  const groups = Math.floor(end / 4);
  const tail = end % 4;
  const out = Buffer.alloc(groups * 3 + (tail === 2 ? 1 : tail === 3 ? 2 : 0));

  let at = 0;
  let bits = 0;
  let count = 0;
  for (let i = 0; i < end; i++) {
    const code = natural.charCodeAt(i);
    const value = code < 128 ? VALUES[code] : -1;
    if (value < 0) {
      throw new Error(
        `"${natural[i]}" is not one of Qoder's 64 body symbols, so this body ` +
          "was not encoded the way this tool knows how to read"
      );
    }
    bits = (bits << 6) | value;
    count++;
    if (count === 4) {
      out[at++] = (bits >> 16) & 0xff;
      out[at++] = (bits >> 8) & 0xff;
      out[at++] = bits & 0xff;
      bits = 0;
      count = 0;
    }
  }
  if (count === 2) out[at++] = (bits >> 4) & 0xff;
  else if (count === 3) {
    out[at++] = (bits >> 10) & 0xff;
    out[at++] = (bits >> 2) & 0xff;
  }

  return out.subarray(0, at).toString("utf8");
}

/**
 * The inverse of decodeQoderBody: standard base64 over QODER_ALPHABET, then the
 * same outer-third swap.
 *
 * The proxy never calls this. It forwards the agent's bytes upstream untouched,
 * so only the decode direction is on the request path. It ships anyway because
 * a codec that can only read cannot be checked against the recorded goldens in
 * both directions, and because building a realistic encoded body otherwise
 * means reimplementing this in every test that wants one.
 */
export function encodeQoderBody(plain: string): string {
  const bytes = Buffer.from(plain, "utf8");
  let natural = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    natural += QODER_ALPHABET[b0 >> 2];
    natural += QODER_ALPHABET[((b0 & 3) << 4) | ((b1 ?? 0) >> 4)];
    natural +=
      b1 === undefined
        ? QODER_PAD
        : QODER_ALPHABET[((b1 & 15) << 2) | ((b2 ?? 0) >> 6)];
    natural += b2 === undefined ? QODER_PAD : QODER_ALPHABET[b2 & 63];
  }
  return swapOuterThird(natural);
}
