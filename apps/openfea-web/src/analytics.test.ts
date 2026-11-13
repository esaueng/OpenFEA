import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Analytics from './analytics';
let analytics: typeof Analytics;
let store: Map<string,string>;
let send: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(async () => {
  vi.resetModules();
  store = new Map();
  vi.stubGlobal('window', Object.assign(new EventTarget(), {
    localStorage: { getItem: (key:string) => store.get(key) ?? null, setItem: (key:string,value:string) => {store.set(key,value);}, removeItem: (key:string) => {store.delete(key);} }
  }));
  vi.stubGlobal('navigator', {doNotTrack:'0'});
  send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null,{status:204}));
  vi.stubGlobal('fetch', send);
  analytics = await import('./analytics');
});
afterEach(() => {vi.unstubAllGlobals();vi.restoreAllMocks();});
describe('Glimpse explicit consent', () => {
  it('defaults off, including the legacy default and opt-out preferences', () => {
    store.set('opencae.analytics.optOut.v1','0');
    expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.trackUsage('workspace_opened');
    expect(send).not.toHaveBeenCalled();
  });
  it('sends only allowlisted values after explicit opt-in and never cookies or referrers', async () => {
    expect(analytics.setAnalyticsEnabled(true)).toBe(true);
    analytics.trackUsage('export_completed');
    expect(send).toHaveBeenCalledOnce();
    const [url,options] = send.mock.calls[0]!;
    if (!options) throw new Error('missing fetch options');
    expect(url).toBe('/api/glimpse/usage');
    expect(options.credentials).toBe('omit'); expect(options.referrerPolicy).toBe('no-referrer');
    expect(JSON.parse(typeof options.body === 'string' ? options.body : '')).toEqual({event:'export_completed',bucket:'none'});
    expect([...store.values()]).toEqual(['granted-v2']);
    analytics.trackUsage('operation_latency',1234);
    expect(JSON.parse(send.mock.calls[1]![1]!.body as string)).toEqual({event:'operation_latency',bucket:'1s_10s'});
  });
  it('withdraws immediately and aborts in-flight sends without reload or retries', () => {
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true); analytics.trackUsage('workspace_opened');
    const signal = send.mock.calls[0]![1]!.signal as AbortSignal;
    analytics.setAnalyticsEnabled(false);
    expect(signal.aborted).toBe(true); expect(analytics.isAnalyticsEnabled()).toBe(false);
    analytics.trackUsage('export_completed'); expect(send).toHaveBeenCalledOnce();
  });
  it('fails closed when preference storage is blocked, including withdrawal write failures', () => {
    analytics.setAnalyticsEnabled(true);
    vi.spyOn(window.localStorage,'removeItem').mockImplementation(() => {throw new Error('blocked');});
    analytics.setAnalyticsEnabled(false); analytics.trackUsage('workspace_opened');
    expect(analytics.isAnalyticsEnabled()).toBe(false); expect(send).not.toHaveBeenCalled();
    vi.spyOn(window.localStorage,'setItem').mockImplementation(() => {throw new Error('blocked');});
    expect(analytics.setAnalyticsEnabled(true)).toBe(false);
    expect(analytics.isAnalyticsEnabled()).toBe(false);
  });
  it('rechecks consent on every send and follows cross-tab withdrawal', () => {
    send.mockImplementation(() => new Promise<Response>(() => undefined));
    analytics.setAnalyticsEnabled(true); analytics.trackUsage('workspace_opened');
    store.clear();
    const event = new Event('storage'); Object.defineProperty(event,'key',{value:null}); window.dispatchEvent(event);
    expect(send.mock.calls[0]![1]!.signal!.aborted).toBe(true);
    analytics.trackUsage('feature_used'); expect(send).toHaveBeenCalledOnce();
  });
  it('honors DNT and GPC and rejects free-text events and invalid timings', () => {
    analytics.setAnalyticsEnabled(true);
    vi.stubGlobal('navigator',{globalPrivacyControl:true}); analytics.trackUsage('workspace_opened');
    vi.stubGlobal('navigator',{doNotTrack:'1'}); analytics.trackUsage('workspace_opened');
    vi.stubGlobal('navigator',{});
    analytics.trackUsage('operation_latency',Infinity); analytics.trackUsage('operation_latency',-1);
    analytics.trackUsage('private.step' as Parameters<typeof analytics.trackUsage>[0]);
    expect(send).not.toHaveBeenCalled();
  });
  it('never throws or retries when delivery fails synchronously', () => {
    analytics.setAnalyticsEnabled(true);
    send.mockImplementation(() => { throw new Error('unavailable'); });
    expect(() => analytics.trackUsage('export_completed')).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
  });

});

it('requires fresh consent for expanded diagnostics and never includes raw data in reports', () => {
    store.set('openfea.glimpse.consent.v1','granted-v1');
    analytics.trackDetail('error_runtime');
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsEnabled(true);
    analytics.trackDetail('error_runtime');
    analytics.trackDetail('private.step');
    analytics.trackDetail('project_size','private-project');
    expect(analytics.diagnosticReport()).toEqual({schema:2,app:'openfea',rows:[{event:'error_runtime',bucket:'none',count:1}]});
    expect(send).toHaveBeenCalledOnce();
    analytics.setAnalyticsEnabled(false);
    expect(analytics.diagnosticReport().rows).toEqual([]);
});
it('records only coarse validated size and part observations', () => {
    analytics.setAnalyticsEnabled(true);
    analytics.trackSize('project_size',1048576);
    analytics.trackParts(7);
    analytics.trackParts(-1); analytics.trackParts(Infinity);
    analytics.trackSize('project_size',NaN);
    expect(analytics.diagnosticReport().rows).toEqual([
      {event:'project_size',bucket:'1_10mib',count:1},
      {event:'part_count',bucket:'2_10',count:1}
    ]);
});

const NEW_CODES = ['error_unresponsive', 'error_gpu_lost', 'error_out_of_memory', 'error_worker'] as const;
function sentBodies(): unknown[] {
  return send.mock.calls.map(call => JSON.parse(call[1]!.body as string));
}
class FakeLongTaskObserver {
  static supportedEntryTypes = ['longtask'];
  static instances: FakeLongTaskObserver[] = [];
  observed: unknown[] = [];
  readonly disconnect = vi.fn();
  constructor(readonly callback: (list: {getEntries(): {duration:number}[]}) => void) { FakeLongTaskObserver.instances.push(this); }
  observe(options: unknown) { this.observed.push(options); }
  emit(...durations: number[]) { this.callback({getEntries: () => durations.map(duration => ({duration}))}); }
}
describe('Glimpse diagnostic codes approved 13 Nov 2026', () => {
  it('sends each new code as the bare code after v2 opt-in only, and suppresses it under DNT/GPC', () => {
    for (const code of NEW_CODES) analytics.trackDetail(code);
    store.set('openfea.glimpse.consent.v1','granted-v1');
    for (const code of NEW_CODES) analytics.trackDetail(code);
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsEnabled(true);
    for (const code of NEW_CODES) analytics.trackDetail(code);
    expect(sentBodies()).toEqual(NEW_CODES.map(event => ({event, bucket:'none'})));
    for (const code of NEW_CODES) analytics.trackDetail(code, 'gte_5s');
    vi.stubGlobal('navigator',{globalPrivacyControl:true}); analytics.trackDetail('error_gpu_lost');
    vi.stubGlobal('navigator',{doNotTrack:'1'}); analytics.trackDetail('error_worker');
    expect(send).toHaveBeenCalledTimes(NEW_CODES.length);
    vi.stubGlobal('navigator',{});
    expect(analytics.diagnosticReport().rows).toEqual(NEW_CODES.map(event => ({event, bucket:'none', count:1})));
    analytics.setAnalyticsEnabled(false);
    expect(analytics.diagnosticReport().rows).toEqual([]);
    analytics.trackDetail('error_out_of_memory');
    expect(send).toHaveBeenCalledTimes(NEW_CODES.length);
  });
  it('keeps the app working when an older Glimpse rejects a code it does not know', async () => {
    analytics.setAnalyticsEnabled(true);
    send.mockResolvedValueOnce(new Response(null,{status:400})).mockRejectedValueOnce(new TypeError('network'));
    expect(() => { analytics.trackDetail('error_worker'); analytics.trackDetail('error_gpu_lost'); }).not.toThrow();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(send).toHaveBeenCalledTimes(2);
    analytics.trackDetail('error_worker');
    expect(send).toHaveBeenCalledTimes(3);
  });
});
describe('error_unresponsive watchdog', () => {
  // A fresh window too, so the module instance from beforeEach cannot react.
  async function reload() {
    vi.stubGlobal('window', Object.assign(new EventTarget(), {localStorage: window.localStorage}));
    vi.resetModules(); analytics = await import('./analytics');
  }
  it('does not observe the page without consent, then counts one code per long task of 5 s or more', async () => {
    FakeLongTaskObserver.instances = [];
    vi.stubGlobal('PerformanceObserver', FakeLongTaskObserver);
    await reload();
    expect(FakeLongTaskObserver.instances).toHaveLength(0);
    analytics.setAnalyticsEnabled(true);
    expect(FakeLongTaskObserver.instances).toHaveLength(1);
    const observer = FakeLongTaskObserver.instances[0]!;
    expect(observer.observed).toEqual([{type:'longtask'}]);
    observer.emit(4999, 120);
    expect(send).not.toHaveBeenCalled();
    observer.emit(5000, 61234);
    expect(sentBodies()).toEqual([{event:'error_unresponsive',bucket:'none'},{event:'error_unresponsive',bucket:'none'}]);
    expect(JSON.stringify(sentBodies())).not.toMatch(/5000|61234/);
    analytics.setAnalyticsEnabled(false);
    expect(observer.disconnect).toHaveBeenCalledOnce();
  });
  it('stays inert where the Long Tasks API is unavailable', async () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    store.set('openfea.glimpse.consent.v1','granted-v2');
    await expect(reload()).resolves.toBeUndefined();
    analytics.setAnalyticsEnabled(false); analytics.setAnalyticsEnabled(true);
    expect(send).not.toHaveBeenCalled();
  });
});
describe('error_gpu_lost for the WebGL viewer', () => {
  function renderer() {
    const canvas = Object.assign(new EventTarget(), {isConnected:true});
    const original = vi.fn();
    return {canvas, original, gl: {domElement: canvas, forceContextLoss: original}};
  }
  it('counts an unexpected context loss but not renderer teardown or a detached canvas', async () => {
    const { watchWebGlContextLoss } = await import('./diagnosticSink');
    analytics.setAnalyticsEnabled(true);
    const lost = renderer();
    watchWebGlContextLoss(lost.gl);
    lost.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(sentBodies()).toEqual([{event:'error_gpu_lost',bucket:'none'}]);

    const disposed = renderer();
    watchWebGlContextLoss(disposed.gl);
    disposed.gl.forceContextLoss();
    expect(disposed.original).toHaveBeenCalledOnce();
    disposed.canvas.dispatchEvent(new Event('webglcontextlost'));

    const detached = renderer();
    watchWebGlContextLoss(detached.gl);
    detached.canvas.isConnected = false;
    detached.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(send).toHaveBeenCalledOnce();
  });
  it('sends nothing without consent', async () => {
    const { watchWebGlContextLoss } = await import('./diagnosticSink');
    const lost = renderer();
    watchWebGlContextLoss(lost.gl);
    lost.canvas.dispatchEvent(new Event('webglcontextlost'));
    expect(send).not.toHaveBeenCalled();
  });
});
describe('worker-client failure sink', () => {
  it('connects worker-client failure codes to the consent-gated sender', async () => {
    const { reportFailureDiagnostic } = await import('./diagnosticSink');
    reportFailureDiagnostic('error_worker');
    expect(send).not.toHaveBeenCalled();
    analytics.setAnalyticsEnabled(true);
    reportFailureDiagnostic('error_worker'); reportFailureDiagnostic('error_out_of_memory'); reportFailureDiagnostic('error_gpu_lost');
    expect(sentBodies()).toEqual([{event:'error_worker',bucket:'none'},{event:'error_out_of_memory',bucket:'none'},{event:'error_gpu_lost',bucket:'none'}]);
  });
});
