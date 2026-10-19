import type { Host } from '../../sdk/index.ts';
type Operation = Awaited<ReturnType<Host['source']['operation']>>;
const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function failure(result: Extract<Operation, { status: 'failed' }>): Error {
  return new Error(typeof result.error === 'object' ? result.error.backend : `播放请求失败：${result.error}`);
}
/** Recover the same operation after transport uncertainty; never resubmit an open. */
export async function submitOnce(host: Host, source: string, operationId: number): Promise<Exclude<Operation, {status:'failed'}>> {
  let result: Operation | undefined;
  let last: unknown;
  try { result = await host.source.submit({ kind:'open', source, startPaused:false }, operationId); } catch(error) { last=error; }
  for (let attempt=0; !result && attempt<30; attempt++) {
    await wait(100);
    try { result=await host.source.operation(operationId); } catch(error) { last=error; }
  }
  if (!result) throw new Error(`无法确认播放请求状态（操作 ${operationId}）：${String(last)}`);
  if(result.status==='failed') throw failure(result);
  return result;
}
export async function openBilibili(host: Host, source: string, operationId: number, signal: AbortSignal, status: (text:string)=>Promise<void>): Promise<void> {
  signal.throwIfAborted();
  await status('正在解析视频和音频…');
  const operation=await submitOnce(host,source,operationId);
  const ticket=operation.ticket;
  let close: Promise<unknown> | undefined;
  const cancel=()=> { close ??= host.source.submit({kind:'close',expected:ticket.stamp}, operationId + 1).catch(()=>{}); };
  signal.addEventListener('abort',cancel,{once:true});
  try {
    if(signal.aborted) { cancel(); signal.throwIfAborted(); }
    for(let attempt=0; attempt<600; attempt++) {
      signal.throwIfAborted();
      const current=await host.source.state();
      signal.throwIfAborted();
      if(current.stamp.generation!==ticket.stamp.generation || current.stamp.intentVersion!==ticket.stamp.intentVersion || current.cycle!==ticket.cycle) throw new Error('播放请求已被其他来源替换。');
      if(current.phase==='ready') { await status('视频已就绪。'); return; }
      if(current.phase==='error') throw new Error(typeof current.terminalReason==='object' && current.terminalReason ? current.terminalReason.failed : '媒体加载失败。');
      if(current.phase==='ended' || current.phase==='empty') throw new Error('播放请求已结束。');
      await wait(100);
    }
    cancel();
    await close;
    throw new Error('媒体加载超时，请重试。');
  } finally {
    signal.removeEventListener('abort',cancel);
    if(signal.aborted) { cancel(); await close; }
  }
}
