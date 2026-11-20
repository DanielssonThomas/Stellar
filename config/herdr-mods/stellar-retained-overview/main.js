import { View, div } from "gpui-kit";
import { appHome, readTextFile } from "herdr";
import { RefreshController, RetainedSnapshot, freshness } from "./snapshot-state.mjs";

export default class StellarRetainedOverview extends View {
  init(_props, cx) {
    this.retained = new RetainedSnapshot();
    this.refresh = new RefreshController(async () => {
      try {
        const raw = await readTextFile(`${appHome()}/stellar-retained-overview.json`);
        if (raw === null) throw new Error("Snapshot file is unavailable.");
        this.retained.accept(raw);
      } catch (error) { this.retained.fail(error); }
    }, (timerCx) => timerCx.notify(), (ms, callback) => cx.timer.after(ms, (timerCx) => callback(timerCx)));
    this.refresh.start();
  }

  close() {
    this.refresh.close();
  }

  render() {
    const root = div().id("stellar-retained-overview-root").flex().flex_col().gap(12).p(16)
      .size_full().overflow_y_scrollbar().bg("#081426").text_color("#eef1f6");
    const text = (value, size = 13, color = "#eef1f6") => div().text_size(size).text_color(color).child(String(value));
    root.child(text("STELLAR / RETAINED WORKERS", 12, "#e4c477"));
    root.child(text("Confirmed launch history · refreshes automatically", 18));
    root.child(text(this.retained.snapshot ? freshness(this.retained.snapshot.generated_at) : "No valid snapshot received", 12, "#b8c2d1"));
    if (this.retained.snapshot) {
      root.child(text(this.retained.snapshot.coverage, 12, "#e4c477"));
      for (const warning of this.retained.snapshot.warnings) root.child(text(`Coverage warning: ${warning}`, 12, "#e4c477"));
      for (const worker of this.retained.snapshot.workers) {
        const card = div().flex().flex_col().gap(5).p(12).rounded(8).bg("#102039").border(1).border_color("#8f7b49");
        card.child(text(`Issue #${worker.issue} · ${worker.role ?? "worker unknown"}`, 15, "#e4c477"));
        card.child(text(worker.summary ?? "Retained launch; details unavailable."));
        card.child(text(`Process: ${worker.process ?? "unavailable"} · task status: ${worker.status ?? "unavailable"}`, 12, "#b8c2d1"));
        if (worker.exit_code !== null && worker.exit_code !== undefined) card.child(text(`Process exit: ${worker.exit_code} · tests/review/merge: ${worker.tests ?? "unverified"}/${worker.review ?? "unverified"}/${worker.merge ?? "unverified"}`, 12, "#b8c2d1"));
        card.child(text(`Claim: ${worker.claim_session ?? "unknown"} · incarnation: ${worker.incarnation ?? worker.attempt ?? "unknown"}`, 11, "#b8c2d1"));
        root.child(card);
      }
      if (this.retained.snapshot.workers.length === 0) root.child(text("No retained records in this snapshot. Coverage is not an all-clear.", 13, "#e4c477"));
    }
    if (this.retained.warning) root.child(text(this.retained.warning, 12, "#e4c477"));
    root.child(text("A process exit, including exit 0, does not establish tests, review, merge or completion.", 12, "#b8c2d1"));
    return root;
  }
}
