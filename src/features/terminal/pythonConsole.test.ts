import { describe, expect, it } from "vitest";
import { consoleInput } from "./pythonConsole";

describe("Execute Selection in Python Console", () => {
  it("sends one line as typed, so the REPL echoes its value", () => {
    expect(consoleInput("  total * 2  \n")).toBe("total * 2\r");
  });

  it("sends a block as one exec of its text, indentation and blank lines intact", () => {
    const block = "def f(x):\n    y = x + 1\n\n    return y  # é\nprint(f(1))\n";
    const sent = consoleInput(block);
    expect(sent).toMatch(
      /^exec\(compile\(__import__\("base64"\)\.b64decode\("[A-Za-z0-9+/=]+"\)\.decode\(\), "<selection>", "exec"\)\)\r$/,
    );
    const b64 = /b64decode\("([^"]+)"\)/.exec(sent)![1]!;
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
    expect(decoded).toBe(block.trimEnd());
  });
});
