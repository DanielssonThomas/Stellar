import { View, div } from 'gpui-kit';
import {
  appHome,
  closeOverlay,
  props,
  readTextFile,
  writeTextFile,
} from 'herdr';
import {
  RefreshController,
  RetainedSnapshot,
  freshness,
  requestedIssue,
} from './snapshot-state.mjs';

export default class StellarRetainedOverview extends View {
  init(_props, cx) {
    this.retained = new RetainedSnapshot();
    this.issueView = null;
    this.overlay = props()?.overlay;
    this.ackTask = null;
    this.ack = null;
    this.renderedRequestId = null;
    this.refresh = new RefreshController(
      async () => {
        if (this.overlay) {
          try {
            const path = `${appHome()}/stellar-retained-overview-request.json`;
            const raw = await readTextFile(path);
            const next = requestedIssue(raw);
            if (next && this.overlay) {
              this.issueView = { ...next, raw, path };
            } else if (
              this.issueView &&
              this.ack?.id !== this.issueView.id &&
              this.issueView.expiresAt <= Date.now() / 1000
            ) {
              this.issueView = {
                ...this.issueView,
                snapshot: null,
                phase: 'expired',
              };
            }
          } catch {
            // A missing, malformed, or superseded request does not change the view.
          }
        }
        if (this.issueView) return;
        try {
          const raw = await readTextFile(
            `${appHome()}/stellar-retained-overview.json`,
          );
          if (raw === null) throw new Error('Snapshot file is unavailable.');
          this.retained.accept(raw);
        } catch (error) {
          this.retained.fail(error);
        }
      },
      (timerCx) => {
        timerCx.notify();
        this.queueAcknowledgment(timerCx);
      },
      (ms, callback) => cx.timer.after(ms, (timerCx) => callback(timerCx)),
    );
    this.refresh.start();
  }

  close() {
    this.overlay = null;
    this.ackTask?.cancel();
    this.refresh.close();
    if (this.ack) void this.invalidate(this.ack);
  }

  async invalidate({ path, raw }) {
    try {
      await writeTextFile(path, JSON.stringify({ closed: true }), raw);
    } catch {
      // A newer request already owns the file, or the app is closing.
    }
  }

  queueAcknowledgment(cx) {
    const view = this.issueView;
    if (
      this.ackTask ||
      !this.overlay ||
      view?.phase !== 'ready' ||
      this.ack?.id === view.id
    ) {
      return;
    }
    this.ackTask = cx.timer.after(16, async (timerCx) => {
      this.ackTask = null;
      if (!this.overlay || this.issueView !== view) return;
      const timestamp = Date.now() / 1000;
      if (timestamp >= view.expiresAt) {
        this.issueView = { ...view, snapshot: null, phase: 'expired' };
        timerCx.notify();
        return;
      }
      if (this.renderedRequestId !== view.id) {
        this.queueAcknowledgment(timerCx);
        return;
      }
      const overlay = this.overlay;
      const record = {
        id: view.id,
        path: view.path,
        raw: view.confirm(overlay, timestamp),
      };
      try {
        await writeTextFile(view.path, record.raw, view.raw);
        if (
          this.overlay === overlay &&
          this.issueView === view &&
          Date.now() / 1000 < view.expiresAt
        ) {
          this.ack = record;
        } else {
          await this.invalidate(record);
        }
      } catch {
        // A superseded request must never receive an acknowledgment.
      }
    });
  }

  render() {
    const snapshot = this.issueView
      ? this.issueView.snapshot
      : this.retained.snapshot;
    const root = div()
      .id('stellar-retained-overview-root')
      .flex()
      .flex_col()
      .gap(12)
      .p(16)
      .size_full()
      .overflow_y_scrollbar()
      .bg('#081426')
      .text_color('#eef1f6');
    const text = (value, size = 13, color = '#eef1f6') =>
      div().text_size(size).text_color(color).child(String(value));
    root.child(text('STELLAR / RETAINED WORKERS', 12, '#e4c477'));
    if (this.overlay && this.issueView) {
      root.child(
        div()
          .id('close-retained-issue')
          .cursor_pointer()
          .text_color('#e4c477')
          .on_click(() => closeOverlay(this.overlay))
          .child('Close'),
      );
    }
    root.child(
      text(
        this.issueView
          ? `Issue #${this.issueView.issue} · retained attempts`
          : 'Confirmed launch history · refreshes automatically',
        18,
      ),
    );
    if (this.issueView) {
      root.child(
        text(
          this.issueView.phase === 'expired'
            ? 'The requested view could not be confirmed. Close this view and try again.'
            : this.issueView.phase === 'opening'
              ? 'Opening the requested retained issue.'
              : 'These are historical attempts. Core may no longer be able to verify their process state.',
          12,
          '#b8c2d1',
        ),
      );
    }
    root.child(
      text(
        snapshot
          ? freshness(snapshot.generated_at)
          : 'No valid snapshot received',
        12,
        '#b8c2d1',
      ),
    );
    if (snapshot) {
      root.child(text(snapshot.coverage, 12, '#e4c477'));
      for (const warning of snapshot.warnings)
        root.child(text(`Coverage warning: ${warning}`, 12, '#e4c477'));
      for (const worker of snapshot.workers) {
        const card = div()
          .flex()
          .flex_col()
          .gap(5)
          .p(12)
          .rounded(8)
          .bg('#102039')
          .border(1)
          .border_color('#8f7b49');
        card.child(
          text(
            `Issue #${worker.issue} · ${worker.role ?? 'worker unknown'}`,
            15,
            '#e4c477',
          ),
        );
        card.child(
          text(worker.summary ?? 'Retained launch; details unavailable.'),
        );
        card.child(
          text(
            `Process: ${worker.process ?? 'unavailable'} · task status: ${worker.status ?? 'unavailable'}`,
            12,
            '#b8c2d1',
          ),
        );
        if (worker.exit_code !== null && worker.exit_code !== undefined)
          card.child(
            text(
              `Process exit: ${worker.exit_code} · tests/review/merge: ${worker.tests ?? 'unverified'}/${worker.review ?? 'unverified'}/${worker.merge ?? 'unverified'}`,
              12,
              '#b8c2d1',
            ),
          );
        card.child(
          text(
            `Claim: ${worker.claim_session ?? 'unknown'} · incarnation: ${worker.incarnation ?? worker.attempt ?? 'unknown'}`,
            11,
            '#b8c2d1',
          ),
        );
        root.child(card);
      }
      if (snapshot.workers.length === 0)
        root.child(
          text(
            'No retained records in this snapshot. Coverage is not an all-clear.',
            13,
            '#e4c477',
          ),
        );
    }
    if (!this.issueView && this.retained.warning)
      root.child(text(this.retained.warning, 12, '#e4c477'));
    root.child(
      text(
        'A process exit, including exit 0, does not establish tests, review, merge or completion.',
        12,
        '#b8c2d1',
      ),
    );
    this.renderedRequestId =
      snapshot && this.issueView?.phase === 'ready' ? this.issueView.id : null;
    return root;
  }
}
