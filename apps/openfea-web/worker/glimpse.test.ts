import { describe, expect, it, vi } from 'vitest';
import { handleGlimpseUsage, parseUsage, countApi, type GlimpseEnv } from './glimpse';
const valid = {event:'export_completed',bucket:'none'};
function request(body: unknown = valid, headers: Record<string,string> = {}) {
  return new Request('https://app.test/api/glimpse/usage',{method:'POST',headers:{Origin:'https://app.test','Content-Type':'application/json',...headers},body:JSON.stringify(body)});
}
function setup() { const record=vi.fn().mockResolvedValue(undefined); const env:GlimpseEnv={GLIMPSE:{record},GLIMPSE_BASIC_ENABLED:'true',GLIMPSE_USAGE_ENABLED:'true',GLIMPSE_USAGE_LIMITER:{limit:vi.fn().mockResolvedValue({success:true})}}; return {record,env}; }
describe('Glimpse privacy boundary',()=>{
  it('rejects every identifying or caller-controlled extra field',()=>{
    for(const key of ['filename','geometry','email','projectName','url','app','level','timestamp','count']) expect(parseUsage({...valid,[key]:'secret'})).toBeNull();
    expect(parseUsage({...valid,event:'private.step'})).toBeNull();
  });
  it('accepts only same-origin POSTs with bounded JSON and strips transport metadata',async()=>{
    const {record,env}=setup();
    expect((await handleGlimpseUsage(request(valid,{'Cookie':'session=private','CF-Connecting-IP':'192.0.2.1'}),env)).status).toBe(204);
    expect(record).toHaveBeenCalledExactlyOnceWith({level:'optional',...valid});
    for(const req of [request(valid,{Origin:'https://other.test'}),request(valid,{'Content-Type':'text/plain'}),request({...valid,email:'secret'}),request({event:'x'.repeat(300),bucket:'none'})]) expect((await handleGlimpseUsage(req,env)).status).toBeGreaterThanOrEqual(400);
    expect(record).toHaveBeenCalledOnce();
  });
  it('enforces the real byte bound without trusting Content-Length',async()=>{
    const {record,env}=setup(); const encoder=new TextEncoder();
    const req=new Request('https://app.test/api/glimpse/usage',{method:'POST',headers:{Origin:'https://app.test','Content-Type':'application/json'},body:new ReadableStream({start(c){c.enqueue(encoder.encode(' '.repeat(300)));c.close();}}),duplex:'half'} as RequestInit);
    expect((await handleGlimpseUsage(req,env)).status).toBe(413);expect(record).not.toHaveBeenCalled();
  });
  it('rejects ingress once the rate limiter refuses it',async()=>{
    const {record,env}=setup(); env.GLIMPSE_USAGE_LIMITER={limit:vi.fn().mockResolvedValue({success:false})};
    expect((await handleGlimpseUsage(request(),env)).status).toBe(429);expect(record).not.toHaveBeenCalled();
  });
  it('keys the rate limit per client so one client cannot exhaust it for everyone',async()=>{
    const {record,env}=setup(); const used=new Map<string,number>();
    const limit=vi.fn(async({key}:{key:string})=>{ const count=(used.get(key)??0)+1; used.set(key,count); return {success:count<=2}; });
    env.GLIMPSE_USAGE_LIMITER={limit};
    const from=(ip:string)=>request(valid,{'CF-Connecting-IP':ip});
    for(let i=0;i<3;i+=1) await handleGlimpseUsage(from('192.0.2.1'),env);
    expect((await handleGlimpseUsage(from('192.0.2.1'),env)).status).toBe(429);
    expect((await handleGlimpseUsage(from('198.51.100.7'),env)).status).toBe(204);
    expect(limit.mock.calls.map(([options])=>options.key)).toEqual(['192.0.2.1','192.0.2.1','192.0.2.1','192.0.2.1','198.51.100.7']);
    expect(record).toHaveBeenCalledTimes(3);
    for(const [value] of record.mock.calls) expect(value).toEqual({level:'optional',...valid});
  });
  it('has deployment kill switches and no required analytics dependency',async()=>{
    const {record,env}=setup(); env.GLIMPSE_USAGE_ENABLED='false'; env.GLIMPSE_BASIC_ENABLED='false';
    await handleGlimpseUsage(request(),env); await countApi(env,500,1400); expect(record).not.toHaveBeenCalled();
    await expect(countApi({},500,1)).resolves.toBeUndefined();
  });
  it('records only fixed backend counters and coarse latency; collector failures never affect operations',async()=>{
    const {record,env}=setup();await countApi(env,503,1500);
    expect(record.mock.calls.map(c=>c[0])).toEqual([{level:'basic',event:'api_request',bucket:'none'},{level:'basic',event:'api_latency',bucket:'1s_10s'},{level:'basic',event:'api_error',bucket:'none'}]);
    record.mockRejectedValue(new Error('unavailable')); await expect(countApi(env,200,10)).resolves.toBeUndefined();
  });
});

it('accepts bounded expanded diagnostics and rejects private text and extra dimensions', () => {
  expect(parseUsage({event:'project_size',bucket:'1_10mib'})).toEqual({level:'optional',event:'project_size',bucket:'1_10mib'});
  expect(parseUsage({event:'error_runtime',bucket:'none'})).toEqual({level:'optional',event:'error_runtime',bucket:'none'});
  expect(parseUsage({event:'error_runtime',bucket:'private.step'})).toBeNull();
  expect(parseUsage({event:'error_runtime',bucket:'none',stack:'private'})).toBeNull();
});

it('keeps client and relay wire vocabularies aligned', async () => {
  const client=await import('../src/glimpseContract');
  const relay=await import('./glimpseContract');
  expect(client.EXPANDED).toEqual(relay.EXPANDED);
  expect(client.CENSUS_FIELDS).toEqual(relay.CENSUS_FIELDS);
});
