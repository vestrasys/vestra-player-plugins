import type { Host } from '../../sdk/index.ts';
import type { SourceOperation, SourceState, SourceTicket } from '../../sdk/source.ts';
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function message(operation: SourceOperation): string {
  return operation.status === 'failed' ? (typeof operation.error === 'string' ? operation.error : operation.error.backend) : operation.status;
}
function newer(state: SourceState, ticket: SourceTicket): boolean {
  return state.stamp.generation > ticket.stamp.generation || (state.stamp.generation === ticket.stamp.generation && state.stamp.intentVersion > ticket.stamp.intentVersion);
}
/** Own operation IDs are queried after uncertain submission; opening is never blindly retried. */
export class YouTubePlayback {
  private next = 0;
  constructor(private readonly source: Host['source'], private readonly pause = delay, private readonly pollLimit = 400) {}
  private async submit(intent: Parameters<Host['source']['submit']>[0]): Promise<SourceOperation> {
    const id = ++this.next;
    try { return await this.source.submit(intent, id); }
    catch {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await this.source.operation(id); } catch { await this.pause(300); }
      }
      throw new Error(`主机操作 ${id} 结果未知，未重新提交；请检查主机状态。`);
    }
  }
  async open(url: string, signal: AbortSignal, status: (message: string) => Promise<void>): Promise<void> {
    if (signal.aborted) throw new Error('Cancelled');
    const id = this.next + 1;
    let result = await this.submit({ kind: 'open', source: url, startPaused: false });
    if (result.status === 'failed') throw new Error(`播放失败：${message(result)}`);
    const ticket = result.ticket;
    let cancelled = false;
    const cancel = async () => {
      if (cancelled) return; cancelled = true;
      const closed = await this.submit({ kind: 'close', expected: ticket.stamp });
      if (closed.status === 'failed' && closed.error !== 'stale' && closed.error !== 'noSource') throw new Error(`取消失败：${message(closed)}`);
    };
    try {
      for (let poll = 0; poll < this.pollLimit; poll++) {
        if (signal.aborted) { await cancel(); throw new Error('Cancelled'); }
        const state = await this.source.state();
        if (signal.aborted) { await cancel(); throw new Error('Cancelled'); }
        if (newer(state, ticket)) throw new Error('播放请求已被新的媒体源替换。');
        const matches = state.cycle === ticket.cycle && state.stamp.generation === ticket.stamp.generation && state.stamp.intentVersion === ticket.stamp.intentVersion;
        if (matches && state.source === url) {
          if (state.phase === 'error') throw new Error(typeof state.terminalReason === 'object' && state.terminalReason ? state.terminalReason.failed : '媒体后端播放失败。');
          if (state.phase === 'ready') { await status('主机媒体源已就绪。'); return; }
          if (state.phase === 'ended' || state.phase === 'empty') throw new Error('播放请求已结束。');
        }
        result = await this.source.operation(id);
        if (result.status === 'failed') throw new Error(`播放失败：${message(result)}`);
        if (poll === 0) await status('正在解析并加载视频与音频…');
        await this.pause(300);
      }
      throw new Error(`播放操作 ${id} 仍未确认就绪；未重新提交，请检查主机状态。`);
    } finally {
      if (signal.aborted && !cancelled) await cancel();
    }
  }
}
