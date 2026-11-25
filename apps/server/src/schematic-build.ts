import { readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { Worker } from 'node:worker_threads';
import type { Issue, PlacedSection, Schematic } from '../../../packages/core/src/types.js';
import type { RoutedSheets } from '../../../packages/core/src/routing.js';

export type BuildRequest = { schematic: unknown; library: unknown[]; options?: {reset?: boolean}; preview?: boolean };
export type BuildReply = {ok: true; json: string; routingWorkers: number} | {ok: false; status: number; message: string; issues?: Issue[]};
type RoutingInput = {schematic:Schematic; sections:PlacedSection[]};
export type ToWorker =
  | {kind:'build'; payload:BuildRequest}
  | ({kind:'route'; sheets:string[]} & RoutingInput)
  | {kind:'plan'; batches:string[][]}
  | {kind:'part'; index:number; result?:RoutedSheets};
export type FromWorker =
  | {kind:'reply'; reply:BuildReply}
  | ({kind:'split'} & RoutingInput)
  | {kind:'routed'; result?:RoutedSheets};

export class BuildPoolError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

type Job = {
  payload: BuildRequest;
  resolve: (reply: BuildReply) => void;
  reject: (error: Error) => void;
  cleanup: () => void;
};
type Slot = { worker: Worker; job?: Job; part?: number; planned?: boolean; retiring?: Promise<number> };
const send = (slot:Slot, message:ToWorker) => slot.worker.postMessage(message);
const timeoutMs = 30_000; // Queue and execution share the same deadline.
const maxRoutingWorkersPerProject = 8; // Includes the worker that placed the components.
const unavailable = () => new BuildPoolError(503,'Сервер завершает работу. Повторите построение позже.');

function defaultWorkers(): number {
  let count = Math.min(4,availableParallelism());
  if (process.platform === 'linux') {
    // Docker can cap CPU time without restricting the CPUs visible to Node.js.
    try {
      const [quota,period] = readFileSync('/sys/fs/cgroup/cpu.max','utf8').trim().split(/\s+/).map(Number);
      if (quota > 0 && period > 0) count = Math.min(count,Math.ceil(quota/period));
    } catch { /* No cgroup v2 quota available. */ }
  }
  return count;
}

function limit(value: number | string | undefined, name: string, fallback: number, min: number, max: number): number {
  if (value === undefined || value === '') return fallback;
  const n = typeof value === 'number' ? value : /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} должен быть целым числом от ${min} до ${max}.`);
  return n;
}

/** Keep sheet order, but split by occupied sheets so blank pages cannot consume a worker. */
export function routingBatches(sheets:readonly string[], occupied:ReadonlySet<string>, count:number):string[][] {
  const active=sheets.flatMap((sheet,i)=>occupied.has(sheet)?[i]:[]);
  const batches=Math.min(count,Math.max(1,active.length));
  const cuts=[0,...Array.from({length:batches-1},(_,i)=>active[Math.floor((i+1)*active.length/batches)]),sheets.length];
  return cuts.slice(0,-1).map((start,i)=>sheets.slice(start,cuts[i+1]));
}

export class SchematicBuildPool {
  private readonly size: number;
  private readonly capacity: number;
  private readonly queue: Job[] = [];
  private readonly slots = new Set<Slot>();
  private closing?: Promise<void>;

  constructor(workers?: number, queue?: number) {
    this.size = limit(workers ?? process.env.SCHEMATIC_BUILD_WORKERS,'SCHEMATIC_BUILD_WORKERS',defaultWorkers(),1,16);
    this.capacity = limit(queue ?? process.env.SCHEMATIC_BUILD_QUEUE,'SCHEMATIC_BUILD_QUEUE',this.size*2,0,32);
  }

  run(payload: BuildRequest, signal: AbortSignal): Promise<BuildReply> {
    if (this.closing) return Promise.reject(unavailable());
    if (signal.aborted) return Promise.reject(new BuildPoolError(499,'Запрос отменён.'));
    const free = this.slots.size < this.size || [...this.slots].some(slot=>!slot.job&&!slot.retiring);
    if (!free && this.queue.length >= this.capacity) return Promise.reject(new BuildPoolError(503,'Очередь построения заполнена. Попробуйте ещё раз.'));
    return new Promise((resolve,reject)=>{
      const cancel = () => this.cancel(job,new BuildPoolError(499,'Запрос отменён.'));
      const timer = setTimeout(()=>this.cancel(job,new BuildPoolError(504,'Построение не уложилось в 30 секунд. Упростите схему или повторите попытку.')),timeoutMs);
      const job: Job = {
        payload,resolve,reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort',cancel); }
      };
      signal.addEventListener('abort',cancel,{once:true});
      this.queue.push(job);
      this.dispatch();
    });
  }

  close(): Promise<void> {
    return this.closing ??= (async()=>{
      for (const job of this.queue.splice(0)) this.reject(job,unavailable());
      await Promise.allSettled([...this.slots].map(slot=>{
        if (slot.job) this.reject(slot.job,unavailable());
        slot.job = undefined;
        return this.retire(slot);
      }));
    })();
  }

  private reject(job: Job, error: Error) { job.cleanup(); job.reject(error); }

  private retire(slot: Slot): Promise<number> {
    return slot.retiring ??= slot.worker.terminate();
  }

  private cancel(job: Job, error: Error) {
    const queued = this.queue.indexOf(job);
    if (queued !== -1) {
      this.queue.splice(queued,1);
      this.reject(job,error);
      return;
    }
    if ([...this.slots].some(slot=>slot.job===job)) {
      this.reject(job,error);
      this.abortSlots(job);
    }
  }

  private abortSlots(job:Job) {
    for (const slot of this.slots) if (slot.job===job) {
      slot.job=undefined;
      void this.retire(slot).catch(()=>{});
    }
  }

  private idle():Slot|undefined {
    return [...this.slots].find(slot=>!slot.job&&!slot.retiring);
  }

  private split(primary:Slot, job:Job, input:RoutingInput) {
    // Only borrow spare capacity. A job never waits for a worker held by a
    // competing request, and the original pool size remains the global limit.
    const sheets=input.schematic.sheets.map(s=>s.id);
    const helpers:Slot[]=[];
    const eligible=new Set(input.sections.map(section=>section.sheet_id));
    const max=Math.min(maxRoutingWorkersPerProject-1,sheets.length-1,eligible.size-1);
    while (!this.queue.length&&helpers.length<max) {
      let helper=this.idle();
      if (!helper&&this.slots.size<this.size) {
        try { helper=this.spawn(); } catch { break; }
      }
      if (!helper) break;
      helper.job=job;
      helper.part=helpers.length+1;
      helpers.push(helper);
    }
    const count=helpers.length+1;
    const batches=routingBatches(sheets,eligible,count);
    send(primary,{kind:'plan',batches});
    for (const [i,helper] of helpers.entries()) {
      try { send(helper,{kind:'route',schematic:input.schematic,sections:input.sections,sheets:batches[i+1]}); }
      catch { this.finishPart(helper); }
    }
  }

  private finishPart(slot:Slot, result?:RoutedSheets) {
    const job=slot.job, index=slot.part;
    slot.job=undefined;
    slot.part=undefined;
    const primary=[...this.slots].find(candidate=>candidate.job===job&&candidate.part===undefined&&!candidate.retiring);
    if (job&&index!==undefined&&primary) send(primary,{kind:'part',index,result});
  }

  private spawn(): Slot {
    const source = import.meta.url.endsWith('.ts');
    const worker = new Worker(new URL(source?'./schematic-worker.ts':'./schematic-worker.js',import.meta.url),{
      execArgv: source?['--import',import.meta.resolve('tsx')]:[],
      resourceLimits: { maxOldGenerationSizeMb: 192, stackSizeMb: 4 }
    });
    const slot: Slot = {worker};
    worker.on('message',(message:FromWorker)=>{
      const job = slot.job;
      if (!job || slot.retiring) return;
      if (message.kind==='split') {
        if (slot.part!==undefined||slot.planned) return;
        slot.planned=true;
        this.split(slot,job,message);
      } else if (message.kind==='routed') {
        if (slot.part===undefined) return;
        this.finishPart(slot,message.result);
      } else {
        if (slot.part!==undefined) return;
        slot.job=undefined;
        slot.planned=false;
        this.abortSlots(job);
        job.cleanup();
        job.resolve(message.reply);
      }
      this.dispatch();
    });
    const failed = () => {
      const job=slot.job;
      if (!job) return;
      if (slot.part!==undefined) this.finishPart(slot);
      else {
        this.reject(job,new BuildPoolError(500,'Вычислительный поток завершился с ошибкой.'));
        this.abortSlots(job);
      }
    };
    worker.on('error',()=>{
      failed();
      void this.retire(slot).catch(()=>{});
    });
    worker.once('exit',()=>{
      failed();
      this.slots.delete(slot);
      this.dispatch();
    });
    this.slots.add(slot);
    return slot;
  }

  private dispatch() {
    while (!this.closing && this.queue.length) {
      let slot = this.idle();
      if (!slot && this.slots.size >= this.size) return;
      const job = this.queue.shift()!;
      try {
        slot ??= this.spawn();
        slot.job = job;
        send(slot,{kind:'build',payload:job.payload});
      } catch {
        if (slot?.job === job) slot.job = undefined;
        this.reject(job,new BuildPoolError(500,'Не удалось передать схему в вычислительный поток.'));
      }
    }
  }
}
