import { describe, expect, it } from "vitest";
import {
  blockAt,
  chunkTarget,
  initialResult,
  mergeTitles,
  parseConflicts,
  resolveAll,
  resolutionText,
  sideChunks,
} from "../conflicts";

const text = [
  "keep\n",
  "<<<<<<< HEAD\n",
  "ours 1\n",
  "ours 2\n",
  "||||||| base\n",
  "base\n",
  "=======\n",
  "theirs\n",
  ">>>>>>> feature\n",
  "tail\n",
  "<<<<<<< HEAD\n",
  "=======\n",
  "only theirs\n",
  ">>>>>>> feature\n",
].join("");

describe("parseConflicts", () => {
  it("parses diff3 and plain blocks", () => {
    const blocks = parseConflicts(text);
    expect(blocks).toHaveLength(2);
    const [a, b] = blocks;
    expect(a).toMatchObject({
      ours: "ours 1\nours 2\n",
      base: "base\n",
      theirs: "theirs\n",
      oursLabel: "HEAD",
      theirsLabel: "feature",
    });
    expect(text.slice(a!.from, a!.to)).toMatch(/^<<<<<<< HEAD\n[\s\S]*>>>>>>> feature\n$/);
    expect(b).toMatchObject({ ours: "", base: null, theirs: "only theirs\n" });
    expect(blockAt(blocks, text.indexOf("theirs\n"))).toBe(a);
    expect(blockAt(blocks, 0)).toBeUndefined();
  });

  it("ignores unterminated markers", () => {
    expect(parseConflicts("<<<<<<< HEAD\nx\n=======\ny\n")).toEqual([]);
  });

  it("resolves blocks", () => {
    expect(resolveAll(text, "ours")).toBe("keep\nours 1\nours 2\ntail\n");
    expect(resolveAll(text, "theirs")).toBe("keep\ntheirs\ntail\nonly theirs\n");
    const [a] = parseConflicts(text);
    expect(resolutionText(a!, "both")).toBe("ours 1\nours 2\ntheirs\n");
    expect(resolutionText(a!, "base")).toBe("base\n");
  });

  it("swaps sides during a rebase, where the user's commit is the >>>>>>> section", () => {
    expect(resolveAll(text, "ours", true)).toBe("keep\ntheirs\ntail\nonly theirs\n");
    expect(resolveAll(text, "theirs", true)).toBe("keep\nours 1\nours 2\ntail\n");
    const [a] = parseConflicts(text);
    expect(resolutionText(a!, "both", true)).toBe("theirs\nours 1\nours 2\n");
    expect(resolutionText(a!, "base", true)).toBe("base\n");
  });
});

describe("mergeTitles", () => {
  const sides = (operation: string | null, extra: Record<string, string | boolean | null> = {}) => ({
    operation,
    reversed: operation === "rebase",
    branch: "feature",
    commit: "abc12345",
    otherBranch: "main",
    ...extra,
  });
  it("names the sides like IDEA for each operation", () => {
    expect(mergeTitles(sides("rebase"))).toEqual({
      yours: "Rebasing abc12345 from feature",
      theirs: "Already rebased commits and commits from main",
    });
    expect(mergeTitles(sides("rebase", { otherBranch: null })).theirs).toBe("Already rebased commits");
    expect(mergeTitles(sides("merge"))).toEqual({ yours: "Changes from feature", theirs: "Changes from main" });
    expect(mergeTitles(sides("cherry-pick"))).toEqual({
      yours: "Local Changes",
      theirs: "Changes from cherry-pick abc12345",
    });
    expect(mergeTitles(sides("unstash"))).toEqual({
      yours: "Your uncommitted changes",
      theirs: "Changes from feature",
    });
    expect(mergeTitles(null)).toEqual({ yours: "Your version", theirs: "Theirs (incoming)" });
  });
});

describe("initialResult", () => {
  const merged = "a\n<<<<<<< yours\nmine\n||||||| base\nold\n=======\nhers\n>>>>>>> theirs\nz\n";

  it("replaces each conflict with its base text, without markers", () => {
    const { text, conflicts } = initialResult(merged);
    expect(text).toBe("a\nold\nz\n");
    expect(conflicts).toEqual([{ from: 2, to: 6, ours: "mine\n", base: "old\n", theirs: "hers\n" }]);
    expect(resolutionText(conflicts[0]!, "ours")).toBe("mine\n");
  });

  it("swaps marker sides written in git's order during a rebase", () => {
    const { conflicts } = initialResult(merged, true);
    expect(conflicts[0]).toMatchObject({ ours: "hers\n", theirs: "mine\n" });
  });

  it("keeps text without conflicts as is", () => {
    expect(initialResult("x\n")).toEqual({ text: "x\n", conflicts: [] });
  });
});

describe("applying side changes to the result", () => {
  const base = "a\nb\nc\nd\n";
  const ours = "a\nB\nc\nd\nours tail\n";
  const theirs = "a\nb2\nc\nD\n";
  const apply = (result: string, t: { from: number; to: number; insert: string }) =>
    result.slice(0, t.from) + t.insert + result.slice(t.to);

  it("lists a side's changes against the base", () => {
    const chunks = sideChunks(base, ours);
    expect(chunks.map((c) => [base.slice(c.fromA, c.toA), ours.slice(c.fromB, c.toB)])).toEqual([
      ["b\n", "B\n"],
      ["", "ours tail\n"],
    ]);
  });

  it("replaces the base text, then appends the other side's change, and knows what is in", () => {
    // The conflict (b) still holds the base text; the non-conflicting changes are merged.
    let result = "a\nb\nc\nD\nours tail\n";
    const [oursB, oursTail] = sideChunks(base, ours);
    const [theirsB, theirsD] = sideChunks(base, theirs);
    expect(chunkTarget(base, ours, result, oursTail!).state).toBe("applied");
    expect(chunkTarget(base, theirs, result, theirsD!).state).toBe("applied");

    const first = chunkTarget(base, ours, result, oursB!);
    expect(first.state).toBe("pending");
    result = apply(result, first);
    expect(result).toBe("a\nB\nc\nD\nours tail\n");
    expect(chunkTarget(base, ours, result, oursB!).state).toBe("applied");

    const second = chunkTarget(base, theirs, result, theirsB!);
    expect(second.state).toBe("modified");
    result = apply(result, second);
    expect(result).toBe("a\nB\nb2\nc\nD\nours tail\n");
    expect(chunkTarget(base, theirs, result, theirsB!).state).toBe("applied");
    expect(chunkTarget(base, ours, result, oursB!).state).toBe("applied");
  });

  it("replaces only its own lines next to a merged change", () => {
    // Theirs changed c (merged); ours changed b, right above it.
    const b3 = "a\nb\nc\n";
    const [mine] = sideChunks(b3, "a\nB\nc\n");
    const target = chunkTarget(b3, "a\nB\nc\n", "a\nb\nC\n", mine!);
    expect(target.state).toBe("pending");
    expect(apply("a\nb\nC\n", target)).toBe("a\nB\nC\n");
  });

  it("applies a deletion and an insertion where the base had nothing", () => {
    const deleted = "a\nc\nd\n";
    const [del] = sideChunks(base, deleted);
    const target = chunkTarget(base, deleted, base, del!);
    expect(target).toMatchObject({ state: "pending", insert: "" });
    expect(apply(base, target)).toBe("a\nc\nd\n");

    const grown = "a\nb\nnew\nc\nd\n";
    const [ins] = sideChunks(base, grown);
    expect(apply(base, chunkTarget(base, grown, base, ins!))).toBe(grown);
  });

  it("works without a base and at the end of a file without a newline", () => {
    const [all] = sideChunks("", "x\ny");
    expect(apply("", chunkTarget("", "x\ny", "", all!))).toBe("x\ny");
    const [last] = sideChunks("a\nb", "a\nB");
    expect(apply("a\nb", chunkTarget("a\nb", "a\nB", "a\nb", last!))).toBe("a\nB");
  });
});
