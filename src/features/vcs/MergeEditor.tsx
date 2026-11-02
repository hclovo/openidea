/** Three-pane merge conflict editor: Yours | Result | Theirs. */
import { useCallback, useEffect, useRef, useState } from "react";
import clsx from "clsx";
import {
  Prec,
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Extension,
} from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from "@codemirror/view";
import { history, historyKeymap } from "@codemirror/commands";
import { keymap } from "@codemirror/view";
import { unifiedMergeView } from "@codemirror/merge";
import type { MergeSides } from "@/bindings";
import { embeddedEditorExtensions } from "@/editor/api";
import { tx, useTxTemplate } from "@/platform/i18n";
import { call, commands } from "@/platform/ipc";
import { Button, IconButton, showContextMenu, Spinner, T } from "@/ui";
import { editorService, type EditorInput } from "@/workbench/contributions";
import { blameSlot, toggleAnnotations } from "./blame";
import { languageFor, viewerBase } from "./cm";
import { confirmDialog } from "./dialogs";
import {
  chunkTarget,
  initialResult,
  mergeTitles,
  resolutionText,
  sideChunks,
  type Resolution,
  type ResultConflict,
  type SideChunk,
} from "./conflicts";
import { baseName } from "./model";
import { errorMessage, readWorkingText, runOp, writeFileText } from "./ops";
import { refreshNow } from "./store";
import styles from "./MergeEditor.module.css";

import type { MergeData } from "./mergeKind";
export { MERGE_KIND, mergeInput, type MergeData } from "./mergeKind";

/** Drops the conflict at an index once a resolution replaced its text. */
const resolvedConflict = StateEffect.define<number>();

function resolveConflict(view: EditorView, index: number, how: Resolution) {
  const c = view.state.field(conflictField).conflicts[index];
  if (!c) return;
  view.dispatch({
    changes: { from: c.from, to: c.to, insert: resolutionText(c, how) },
    effects: resolvedConflict.of(index),
    userEvent: "input.resolve",
  });
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly index: number,
    readonly hasBase: boolean,
  ) {
    super();
  }
  eq(o: ActionsWidget) {
    return o.index === this.index && o.hasBase === this.hasBase;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "cm-conflict-actions";
    const add = (label: string, how: Resolution) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = label;
      // Keep the caret / focus in the editor; resolve on click (mouse or keyboard).
      b.onmousedown = (e) => e.preventDefault();
      b.onclick = (e) => {
        e.preventDefault();
        resolveConflict(view, this.index, how);
      };
      el.appendChild(b);
    };
    const title = document.createElement("span");
    title.textContent = `Conflict ${this.index + 1}`;
    el.appendChild(title);
    add("Accept Yours", "ours");
    add("Accept Theirs", "theirs");
    add("Accept Both", "both");
    if (this.hasBase) add("Use Base", "base");
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

const conflictLine = Decoration.line({ class: "cm-conflict-marker" });

function decorate(state: EditorState, conflicts: readonly ResultConflict[]): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = state.doc;
  conflicts.forEach((c, i) => {
    b.add(c.from, c.from, Decoration.widget({ widget: new ActionsWidget(i, c.base !== null), block: true, side: -1 }));
    if (c.to <= c.from) return;
    const endLine = doc.lineAt(c.to - 1).number;
    for (let n = doc.lineAt(c.from).number; n <= endLine; n++) b.add(doc.line(n).from, doc.line(n).from, conflictLine);
  });
  return b.finish();
}

/**
 * The result's unresolved conflicts, tracked as ranges holding the base text (no
 * markers), as IDEA's merge dialog shows them. Typing at a conflict's edges stays in it.
 */
const conflictField = StateField.define<{ conflicts: ResultConflict[]; deco: DecorationSet }>({
  create: () => ({ conflicts: [], deco: Decoration.none }),
  update(v, tr) {
    const done = new Set(tr.effects.filter((e) => e.is(resolvedConflict)).map((e) => e.value as number));
    let conflicts = v.conflicts.filter((_, i) => !done.has(i));
    if (tr.docChanged)
      conflicts = conflicts.map((c) => ({ ...c, from: tr.changes.mapPos(c.from, -1), to: tr.changes.mapPos(c.to, 1) }));
    if (!tr.docChanged && !done.size) return v;
    return { conflicts, deco: decorate(tr.state, conflicts) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

const resultTheme = EditorView.baseTheme({
  ".cm-conflict-marker": {
    backgroundColor: "color-mix(in srgb, var(--vcs-conflict) 14%, transparent)",
    color: "var(--fg-subtle)",
  },
  ".cm-conflict-actions": {
    display: "flex",
    alignItems: "center",
    gap: "6px",
    padding: "3px 8px",
    fontFamily: "var(--font-ui)",
    fontSize: "var(--fs-small)",
    color: "var(--vcs-conflict)",
    background: "var(--bg-elev)",
    borderTop: "1px solid var(--border)",
  },
  ".cm-conflict-actions button": {
    padding: "0 6px",
    border: "1px solid var(--border-strong)",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "var(--bg-control)",
    font: "inherit",
    lineHeight: "18px",
  },
  ".cm-conflict-actions button:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
});

type ChunkState = ReturnType<typeof chunkTarget>["state"];

/** Where each change of a side pane stands in the result, recomputed as the result changes. */
const setChunkStates = StateEffect.define<readonly ChunkState[]>();

class ApplyMarker extends GutterMarker {
  constructor(
    readonly index: number,
    readonly arrow: string,
    readonly append: boolean,
  ) {
    super();
  }
  override eq(o: ApplyMarker) {
    return o.index === this.index && o.arrow === this.arrow && o.append === this.append;
  }
  override toDOM() {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "cm-mergeApply";
    b.dataset.chunk = String(this.index);
    b.textContent = this.arrow;
    b.title = this.append ? tx("Append to the result") : tx("Apply to the result");
    return b;
  }
}

/**
 * IDEA's `>>` / `<<` beside the changes of a side pane, on the edge next to the result:
 * each applies one change to the result, until the result has it.
 */
function applyGutter(chunks: readonly SideChunk[], arrow: "»" | "«", onApply: (index: number) => void): Extension {
  const markers = StateField.define<RangeSet<GutterMarker>>({
    create: () => RangeSet.empty,
    update(value, tr) {
      const states = tr.effects.findLast((e) => e.is(setChunkStates))?.value as readonly ChunkState[] | undefined;
      if (!states) return value;
      const b = new RangeSetBuilder<GutterMarker>();
      chunks.forEach((c, i) => {
        const state = states[i];
        if (!state || state === "applied") return;
        const line = tr.state.doc.lineAt(c.fromB).from;
        b.add(line, line, new ApplyMarker(i, arrow, state === "modified"));
      });
      return b.finish();
    },
  });
  return [
    markers,
    Prec.highest(
      gutter({
        class: "cm-mergeApplyGutter",
        side: arrow === "»" ? "after" : "before",
        markers: (view) => view.state.field(markers),
        domEventHandlers: {
          mousedown(_view, _line, event) {
            const target = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-chunk]");
            if (!target || (event as MouseEvent).button !== 0) return false;
            event.preventDefault();
            onApply(Number(target.dataset.chunk));
            return true;
          },
        },
      }),
    ),
  ];
}

const applyTheme = EditorView.baseTheme({
  ".cm-mergeApplyGutter .cm-gutterElement": { display: "flex", alignItems: "center", justifyContent: "center" },
  ".cm-mergeApply": {
    width: "18px",
    padding: "0",
    border: "none",
    borderRadius: "var(--radius-small)",
    color: "var(--fg-secondary)",
    background: "transparent",
    font: "inherit",
    lineHeight: "inherit",
    cursor: "pointer",
  },
  ".cm-mergeApply:hover": { color: "var(--fg-strong)", background: "var(--bg-control-hover)" },
});

export function MergeEditor({ input }: { input: EditorInput }) {
  const { path } = input.data as MergeData;
  const [state, setState] = useState<{
    ours: string;
    theirs: string;
    base: string | null;
    working: string;
    merged: string | null;
    sides: MergeSides;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lang, setLang] = useState<Extension | null>(null);
  const [left, setLeft] = useState(0);
  const [resolved, setResolved] = useState(false);
  const oursRef = useRef<HTMLDivElement>(null);
  const resultRef = useRef<HTMLDivElement>(null);
  const theirsRef = useRef<HTMLDivElement>(null);
  const resultView = useRef<EditorView | null>(null);
  const oursView = useRef<EditorView | null>(null);
  const theirsView = useRef<EditorView | null>(null);
  const txt = useTxTemplate();
  const titles = mergeTitles(state?.sides);

  const load = useCallback(async () => {
    try {
      const [v, working] = await Promise.all([call(commands.vcsConflictVersions(path)), readWorkingText(path)]);
      setState({
        ours: v.ours ?? "",
        theirs: v.theirs ?? "",
        base: v.base,
        working: working ?? "",
        merged: v.merged,
        sides: v.sides,
      });
      setError(null);
    } catch (e) {
      setError(errorMessage(e));
    }
  }, [path]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);
  useEffect(() => {
    let alive = true;
    void languageFor(path).then((l) => alive && setLang(() => l ?? []));
    return () => {
      alive = false;
    };
  }, [path]);

  useEffect(() => {
    if (!state || lang === null || !oursRef.current || !resultRef.current || !theirsRef.current) return;
    // Each side's changes against the base can be applied to the result (none without a base).
    const base = state.base;
    const chunks = {
      ours: base === null ? [] : sideChunks(base, state.ours),
      theirs: base === null ? [] : sideChunks(base, state.theirs),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refreshChunks = () => {
      clearTimeout(timer);
      timer = undefined;
      if (base === null) return;
      const text = result.state.doc.toString();
      const changes = sideChunks(base, text);
      const states = (which: "ours" | "theirs") =>
        setChunkStates.of(chunks[which].map((c) => chunkTarget(base, state[which], text, c, changes).state));
      ours.dispatch({ effects: states("ours") });
      theirs.dispatch({ effects: states("theirs") });
    };
    const applyFrom = (which: "ours" | "theirs") => (index: number) => {
      const view = resultView.current;
      const chunk = chunks[which][index];
      if (!view || !chunk || base === null) return;
      const t = chunkTarget(base, state[which], view.state.doc.toString(), chunk);
      if (t.state === "applied") return;
      // Conflicts the change lands on are resolved by it.
      const point = t.from === t.to;
      const covered = view.state
        .field(conflictField)
        .conflicts.flatMap((c, i) =>
          (point || c.from === c.to ? c.from <= t.to && c.to >= t.from : c.from < t.to && c.to > t.from) ? [i] : [],
        );
      view.dispatch({
        changes: { from: t.from, to: t.to, insert: t.insert },
        effects: covered.map((i) => resolvedConflict.of(i)),
        userEvent: "input.resolve",
      });
      refreshChunks();
    };
    const side = (which: "ours" | "theirs") => [
      viewerBase({ readOnly: true }),
      lang,
      blameSlot(),
      base !== null ? unifiedMergeView({ original: base, mergeControls: false, gutter: true }) : [],
      applyGutter(chunks[which], which === "ours" ? "»" : "«", applyFrom(which)),
      applyTheme,
    ];
    const ours = new EditorView({ doc: state.ours, parent: oursRef.current, extensions: side("ours") });
    const theirs = new EditorView({ doc: state.theirs, parent: theirsRef.current, extensions: side("theirs") });
    // Like IDEA, start from the three-way merge (non-conflicting changes applied, conflicts
    // showing the base) rather than the marker-laden working copy.
    const start =
      state.merged !== null ? initialResult(state.merged) : initialResult(state.working, state.sides.reversed);
    const result = new EditorView({
      doc: start.text,
      parent: resultRef.current,
      extensions: [
        viewerBase({ readOnly: false }),
        history(),
        keymap.of(historyKeymap),
        embeddedEditorExtensions(path),
        lang,
        conflictField.init((s) => ({ conflicts: start.conflicts, deco: decorate(s, start.conflicts) })),
        resultTheme,
        EditorView.updateListener.of((u) => {
          if (!u.docChanged) return;
          setLeft(u.state.field(conflictField).conflicts.length);
          clearTimeout(timer);
          timer = setTimeout(refreshChunks, 150);
        }),
      ],
    });
    resultView.current = result;
    setLeft(result.state.field(conflictField).conflicts.length);
    refreshChunks();
    oursView.current = ours;
    theirsView.current = theirs;
    // Scroll the three panes together (by scroll ratio), like IDEA's merge view.
    const views = [ours, result, theirs];
    let syncing = false;
    const onScroll = (from: EditorView) => () => {
      if (syncing) return;
      syncing = true;
      const s = from.scrollDOM;
      const ratio = s.scrollTop / Math.max(1, s.scrollHeight - s.clientHeight);
      for (const other of views) {
        if (other === from) continue;
        const o = other.scrollDOM;
        o.scrollTop = ratio * Math.max(0, o.scrollHeight - o.clientHeight);
      }
      syncing = false;
    };
    const offs = views.map((v) => {
      const h = onScroll(v);
      v.scrollDOM.addEventListener("scroll", h, { passive: true });
      return () => v.scrollDOM.removeEventListener("scroll", h);
    });
    return () => {
      clearTimeout(timer);
      offs.forEach((off) => off());
      ours.destroy();
      theirs.destroy();
      result.destroy();
      resultView.current = null;
      oursView.current = null;
      theirsView.current = null;
    };
  }, [state, lang, path]);

  const goto = (dir: 1 | -1) => {
    const v = resultView.current;
    if (!v) return;
    const blocks = v.state.field(conflictField).conflicts;
    if (!blocks.length) return;
    const head = v.state.selection.main.head;
    const target =
      dir === 1
        ? (blocks.find((b) => b.from > head) ?? blocks[0]!)
        : ([...blocks].reverse().find((b) => b.to < head) ?? blocks[blocks.length - 1]!);
    v.dispatch({
      selection: { anchor: target.from },
      effects: EditorView.scrollIntoView(target.from, { y: "center" }),
    });
    v.focus();
  };

  const acceptAll = (how: Resolution) => {
    const v = resultView.current;
    if (!v) return;
    const conflicts = v.state.field(conflictField).conflicts;
    v.dispatch({
      changes: conflicts.map((c) => ({ from: c.from, to: c.to, insert: resolutionText(c, how) })),
      effects: conflicts.map((_, i) => resolvedConflict.of(i)),
      userEvent: "input.resolve",
    });
  };

  const apply = async () => {
    const v = resultView.current;
    if (!v) return;
    const remaining = v.state.field(conflictField).conflicts.length;
    if (
      remaining > 0 &&
      !(await confirmDialog({
        title: "Unresolved Conflicts",
        message:
          remaining === 1
            ? tx`${remaining} conflict is unresolved and keeps the base text. Save and mark the file as resolved anyway?`
            : tx`${remaining} conflicts are unresolved and keep the base text. Save and mark the file as resolved anyway?`,
        okLabel: "Mark Resolved",
      }))
    )
      return;
    const text = v.state.doc.toString();
    const ok = await runOp(
      `Resolve ${baseName(path)}`,
      async () => {
        await writeFileText(path, text, { save: true });
        await call(commands.vcsStage([path]));
        return true;
      },
      { success: `${baseName(path)}: conflicts resolved` },
    );
    if (ok) {
      setResolved(true);
      await refreshNow();
      // Like IDEA, applying the result closes the merge editor.
      await editorService().closeInput?.(input.key);
    }
  };

  // IDEA's merge view: F7 / Shift+F7 jump between conflicts; each side pane can
  // annotate its version with Git Blame from the context menu.
  // Each side pane blames on the branch it belongs to, so lines that only exist on
  // the other branch show their real history instead of "Not Committed Yet".
  const otherRev = state?.sides.commit ?? "HEAD";
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "F7") {
      e.preventDefault();
      goto(e.shiftKey ? -1 : 1);
    }
  };

  const sideMenu = (e: React.MouseEvent, viewRef: { current: EditorView | null }, text: string, revision?: string) => {
    const view = viewRef.current;
    if (!view) return;
    e.preventDefault();
    showContextMenu(e.nativeEvent, [
      {
        label: "Annotate with Git Blame",
        icon: "changelist",
        run: () => void toggleAnnotations(view, path, text, revision),
      },
    ]);
  };

  if (error)
    return (
      <div className={styles.message}>
        {error}
        <Button onClick={() => void load()}>
          <T>Retry</T>
        </Button>
      </div>
    );
  if (resolved)
    return (
      <div className={styles.message}>
        {tx`${baseName(path)} has been resolved and staged.`}
        <Button onClick={() => void editorService().openFile(path, { focus: true })}>
          <T>Open File</T>
        </Button>
      </div>
    );

  return (
    <div className={styles.root} onKeyDown={onKeyDown}>
      <div className={styles.toolbar} role="toolbar" aria-label={tx("Merge")}>
        <IconButton icon="arrow-up" title="Previous Conflict" size="small" onClick={() => goto(-1)} />
        <IconButton icon="arrow-down" title="Next Conflict" size="small" onClick={() => goto(1)} />
        <span className={styles.sep} />
        <Button size="small" onClick={() => acceptAll("ours")}>
          <T>Accept All Yours</T>
        </Button>
        <Button size="small" onClick={() => acceptAll("theirs")}>
          <T>Accept All Theirs</T>
        </Button>
        <IconButton icon="refresh" title="Reload from Disk" size="small" onClick={() => void load()} />
        <span className={clsx(styles.status, !left && styles.statusDone)}>
          {left === 1 ? tx`${left} conflict left` : left ? tx`${left} conflicts left` : tx("All conflicts resolved")}
        </span>
        <Button size="small" variant="primary" onClick={() => void apply()}>
          <T>Apply</T>
        </Button>
      </div>
      <div className={styles.labels}>
        <span>{txt(titles.yours)}</span>
        <span>
          <T>Result</T>
        </span>
        <span>{txt(titles.theirs)}</span>
      </div>
      {!state || lang === null ? (
        <div className={styles.message}>
          <Spinner size={14} />
        </div>
      ) : null}
      <div className={styles.panes} hidden={!state || lang === null}>
        <div
          ref={oursRef}
          className={styles.pane}
          aria-label={tx("Your version")}
          role="region"
          onContextMenu={(e) => sideMenu(e, oursView, state?.ours ?? "", state?.sides.reversed ? otherRev : "HEAD")}
        />
        <div ref={resultRef} className={styles.pane} aria-label={tx("Result")} role="region" />
        <div
          ref={theirsRef}
          className={styles.pane}
          aria-label={tx("Their version")}
          role="region"
          onContextMenu={(e) => sideMenu(e, theirsView, state?.theirs ?? "", state?.sides.reversed ? "HEAD" : otherRev)}
        />
      </div>
    </div>
  );
}
