import { shellEndpoints as E } from '@castlane/api-contracts';
import { globalSearch, membershipStillActive, readStream, streamHead, unreadCount } from '@castlane/application';
import { route } from '../http/router';

route(E.search, async ({ ctx, input }) => globalSearch(ctx, input.query));

route(E.unreadCount, async ({ ctx }) => ({ unread: await unreadCount(ctx.app.db, ctx.actor.workspaceId, ctx.actor.membershipId!) }));

/**
 * SSE: polls the safe change feed every 2 s, heartbeats every 15 s and re-verifies the membership
 * at least every 30 s — a revoked member is disconnected and must re-authenticate.
 */
route(E.events, async ({ ctx, http, res }) => {
  const db = ctx.app.db;
  const membershipId = ctx.actor.membershipId!;
  const workspaceId = ctx.actor.workspaceId;
  const revision = ctx.actor.access.accessRevision;
  const lastId = Number(http.headers.get('last-event-id') ?? http.url.searchParams.get('lastEventId') ?? 'NaN');
  const head = await streamHead(db, workspaceId);
  let cursor = Number.isFinite(lastId) ? lastId : head.max;
  const needsResync = Number.isFinite(lastId) && head.min > 0 && lastId < head.min - 1;
  const encoder = new TextEncoder();
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (s: string) => {
        if (!closed) controller.enqueue(encoder.encode(s));
      };
      send('retry: 5000\n\n');
      if (needsResync) send(`event: resync\ndata: {}\n\n`);
      let lastCheck = Date.now();
      let lastBeat = Date.now();
      const tick = async () => {
        if (closed) return;
        try {
          if (Date.now() - lastCheck > 25_000) {
            lastCheck = Date.now();
            const state = await membershipStillActive(db, membershipId, revision);
            if (state !== 'active') {
              send(`event: access_changed\ndata: {"state":"${state}"}\n\n`);
              closed = true;
              controller.close();
              return;
            }
          }
          const events = await readStream(db, workspaceId, membershipId, cursor);
          for (const e of events) {
            cursor = e.seq;
            send(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify({ t: e.entityType, id: e.entityId, r: e.revision })}\n\n`);
          }
          if (Date.now() - lastBeat > 15_000) {
            lastBeat = Date.now();
            send(': heartbeat\n\n');
          }
        } catch {
          // transient DB error: keep the connection; the client also polls every 30 s as fallback
        }
        if (!closed) setTimeout(tick, 2000);
      };
      void tick();
      http.request.signal.addEventListener('abort', () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      closed = true;
    },
  });
  res.raw = new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
  return null;
});
