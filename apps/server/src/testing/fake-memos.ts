// Test support: a fake MemOS REST server on loopback (never the real one). It models the parts
// of MemOS v2.0.36 (commit 3a16e5f) the adapter must cope with (docs/adr/0023):
// - add/search without explicit cube ids fall back to the `user_id` as the cube;
// - `info` keys that collide with MemOS metadata fields are dropped, the rest flattened into
//   the node's metadata;
// - an async add answers with ids that `settle()` later replaces (the scheduler's rewrite);
// - delete by `memory_ids` is not scoped to a cube; any user/session/filter field turns it into
//   a bulk delete (or a 200 "failure" when combined with ids);
// - create_cube refuses an unknown owner (400) and an existing cube (500);
// - errors are HTTP 4xx/5xx, failures inside 200 have `data.status: failure`.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeMemosNode {
  id: string;
  memory: string;
  cube: string;
  metadata: Record<string, unknown>;
}

export interface FakeMemosOptions {
  /** Users create_cube accepts as owners (MemOS only guarantees `root`). */
  users?: string[];
  /** On `settle()`, async adds are rewritten under new ids; keep our info keys or drop them. */
  rewriteKeepsInfo?: boolean;
}

/** MemOS metadata field names an `info` key may not use (a subset of `list_all_fields()`). */
const RESERVED_INFO = new Set(['source', 'key', 'type', 'status', 'tags', 'user_id', 'info']);

export class FakeMemos {
  readonly requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  readonly nodes: FakeMemosNode[] = [];
  readonly cubes = new Set<string>();
  /** Answer every /product request with this status (null = behave). */
  failStatus: number | null = null;
  /** Wait this long before answering (timeouts). */
  delayMs = 0;
  /** Store items without a vector (MemOS #2461). */
  noVector = false;
  private pendingRewrite: string[] = [];
  private counter = 0;
  private server: Server | undefined;
  url = '';

  constructor(private readonly options: FakeMemosOptions = {}) {}

  private newId(): string {
    this.counter += 1;
    return `11111111-1111-4111-8111-${String(this.counter).padStart(12, '0')}`;
  }

  /** Put a node into a cube directly (someone else's data, or an earlier write). */
  seed(cube: string, memory: string, metadata: Record<string, unknown> = {}): FakeMemosNode {
    const node: FakeMemosNode = {
      id: this.newId(),
      memory,
      cube,
      metadata: { memory_type: 'LongTermMemory', vector_sync: 'success', ...metadata },
    };
    this.nodes.push(node);
    return node;
  }

  /** The scheduler's MEM_READ: every async item is replaced by a rewritten one with a new id. */
  settle(): void {
    for (const id of this.pendingRewrite.splice(0)) {
      const i = this.nodes.findIndex((n) => n.id === id);
      if (i < 0) continue;
      const old = this.nodes[i]!;
      const metadata = this.options.rewriteKeepsInfo
        ? { ...old.metadata }
        : { memory_type: 'LongTermMemory', vector_sync: 'success' };
      this.nodes.splice(i, 1, {
        id: this.newId(),
        cube: old.cube,
        memory: `摘要：${old.memory.replace(/^user: /, '')}`,
        metadata,
      });
    }
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      void this.handle(req).then(({ status, body }) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    const { port } = this.server.address() as AddressInfo;
    this.url = `http://127.0.0.1:${port}`;
    return this.url;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
  }

  private async handle(req: IncomingMessage): Promise<{ status: number; body: unknown }> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = (text === '' ? {} : JSON.parse(text)) as Record<string, unknown>;
    const path = req.url ?? '';
    this.requests.push({ method: req.method ?? 'GET', path, body });
    if (this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
    if (path === '/health')
      return { status: 200, body: { status: 'healthy', service: 'memos', version: '1.0.1' } };
    if (this.failStatus !== null) return { status: this.failStatus, body: { detail: 'boom' } };
    const ok = (data: unknown, message = 'ok') => ({
      status: 200,
      body: { code: 200, message, data },
    });
    switch (path) {
      case '/product/create_cube': {
        const owner = String(body['owner_id']);
        if (!(this.options.users ?? ['root']).includes(owner)) {
          return {
            status: 400,
            body: { detail: `Owner user '${owner}' does not exist or is inactive` },
          };
        }
        const cube = String(body['cube_id']);
        if (this.cubes.has(cube))
          return { status: 500, body: { detail: 'Failed to create cube: UNIQUE' } };
        this.cubes.add(cube);
        return ok({ cube_id: cube, cube_name: body['cube_name'], owner_id: owner });
      }
      case '/product/add':
        return ok(this.add(body));
      case '/product/search':
        return ok(this.search(body));
      case '/product/get_memory': {
        if (typeof body['mem_cube_id'] !== 'string')
          return { status: 422, body: { detail: 'mem_cube_id' } };
        return ok(this.getMemory(body));
      }
      case '/product/delete_memory':
        return ok(this.delete(body));
      default:
        return { status: 404, body: { detail: 'Not Found' } };
    }
  }

  private add(body: Record<string, unknown>) {
    const cubes = (body['writable_cube_ids'] as string[] | undefined) ?? [String(body['user_id'])];
    const info = Object.fromEntries(
      Object.entries((body['info'] as Record<string, unknown> | undefined) ?? {}).filter(
        ([k]) => !RESERVED_INFO.has(k),
      ),
    );
    const out: unknown[] = [];
    for (const message of (body['messages'] as Array<{ role: string; content: string }>) ?? []) {
      for (const cube of cubes) {
        const node: FakeMemosNode = {
          id: this.newId(),
          cube,
          memory: `${message.role}: ${message.content}\n`,
          metadata: {
            ...info,
            user_id: body['user_id'],
            memory_type: 'UserMemory',
            vector_sync: this.noVector ? 'failed' : 'success',
            created_at: '2026-11-22T00:00:00',
          },
        };
        this.nodes.push(node);
        if (body['async_mode'] !== 'sync') this.pendingRewrite.push(node.id);
        out.push({
          memory: node.memory,
          memory_id: node.id,
          memory_type: 'UserMemory',
          cube_id: cube,
        });
      }
    }
    return out;
  }

  private bucket(cube: string, nodes: FakeMemosNode[], total = nodes.length) {
    return {
      cube_id: cube,
      memories: nodes.map((n) => ({
        id: n.id,
        memory: n.memory,
        metadata: { ...n.metadata, embedding: [] },
      })),
      total_nodes: total,
    };
  }

  private search(body: Record<string, unknown>) {
    const cubes = (body['readable_cube_ids'] as string[] | undefined) ?? [String(body['user_id'])];
    const words = String(body['query'])
      .split(/\s+/)
      .filter((w) => w.length > 1);
    const min = Number(body['relativity'] ?? 0.45);
    const topK = Number(body['top_k'] ?? 10);
    return {
      text_mem: cubes.map((cube) => {
        const hits = this.nodes
          .filter((n) => n.cube === cube && n.metadata['vector_sync'] === 'success')
          .map((n) => ({
            ...n,
            metadata: {
              ...n.metadata,
              relativity: words.some((w) => n.memory.includes(w)) ? 0.9 : 0.1,
            },
          }))
          .filter((n) => (n.metadata.relativity as number) >= min)
          .slice(0, topK);
        return this.bucket(cube, hits);
      }),
      act_mem: [],
      para_mem: [],
      pref_mem: [],
      pref_note: '',
      tool_mem: [],
      skill_mem: [],
    };
  }

  private getMemory(body: Record<string, unknown>) {
    const cube = String(body['mem_cube_id']);
    const filter = body['filter'] as { and?: Array<Record<string, unknown>> } | undefined;
    const id = filter?.and?.find((c) => 'id' in c)?.['id'];
    const all = this.nodes
      .filter((n) => n.cube === cube && (id === undefined || n.id === id))
      .reverse();
    const page = Number(body['page'] ?? 1);
    const size = Number(body['page_size'] ?? all.length);
    return {
      text_mem: [this.bucket(cube, all.slice((page - 1) * size, page * size), all.length)],
      pref_mem: [],
      tool_mem: [],
      skill_mem: [],
    };
  }

  private delete(body: Record<string, unknown>) {
    const ids = body['memory_ids'] as string[] | undefined;
    const bulk = ['user_id', 'session_id', 'filter'].some((k) => body[k] !== undefined);
    if (ids !== undefined && bulk) return { status: 'failure' };
    if (bulk) {
      // a quick delete: everything of that user, in every cube
      const user = body['user_id'];
      for (let i = this.nodes.length - 1; i >= 0; i--) {
        if (this.nodes[i]!.metadata['user_id'] === user) this.nodes.splice(i, 1);
      }
      return { status: 'success' };
    }
    // by id, in whatever cube the node is (MemOS does not scope this)
    for (const id of ids ?? []) {
      const i = this.nodes.findIndex((n) => n.id === id);
      if (i >= 0) this.nodes.splice(i, 1);
    }
    return { status: 'success' };
  }
}
