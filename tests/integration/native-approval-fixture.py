"""Loopback-only integration fixture: real Hermes HTTP/authority/waiter; deterministic LLM boundary.

Run with an isolated HERMES_HOME and PYTHONPATH pointing at the qualified native checkout.
The /_fixture/expire endpoint advances only this disposable process's approval clock.
"""
import asyncio
import json
import os
import time
from pathlib import Path
from types import SimpleNamespace

from aiohttp import web
from gateway.config import GatewayConfig, PlatformConfig
from gateway.platforms.api_server import APIServerAdapter
from gateway.session import SessionStore
from gateway.session_authority import SessionAuthority
from gateway.session_results import execution_result
from hermes_state import SessionDB
from hermes_state_runtime import begin_runtime_epoch
from tools import approval
from tools.approval_gateway_wait import _await_gateway_decision
from tools import approval_gateway_wait as wait_module
from tools.approval_context import _get_approval_timeout


async def main():
    home = Path(os.environ['HERMES_HOME'])
    home.mkdir(parents=True, exist_ok=True)
    db = SessionDB(home / 'state.db')
    store = SessionStore(config=GatewayConfig(), sessions_dir=home / 'sessions')
    store._db = db
    runner = SimpleNamespace(_draining=False, session_store=store)
    authority = SessionAuthority(runner, profile_id='default', instance_id='approval-fixture', db=db,
                                 epoch=begin_runtime_epoch(db, instance_id='approval-fixture'))
    runner.session_authority = authority
    api = APIServerAdapter(PlatformConfig(enabled=True))
    api._api_key = 'native-fixture-only'
    api.gateway_runner = runner
    api._session_db = db
    runner._adapter_for_source = lambda source: api
    outcomes = {}
    assert _get_approval_timeout() == 1800, 'task-local native config must reach real waiter'
    clock_offset = [0]
    # A fixture clock seam only; all HTTP, SQLite and waiter source stays unmodified.
    wait_module.time = SimpleNamespace(monotonic=lambda: time.monotonic() + clock_offset[0])

    async def handle(event):
        sid = event.source.chat_id
        generation = db.get_session(sid)['runtime_generation']

        def notify(data):
            authority.register_approval(sid, generation, sid, data)

        result = await asyncio.to_thread(_await_gateway_decision, sid, notify, {
            'command': 'fixture required source read', 'description': 'Fixture approval, no shell execution',
            'request_id': sid + '_approval', 'allow_session': False, 'allow_permanent': False})
        outcomes[sid] = {'resolved': result['resolved'], 'choice': result['choice']}
        # Deliberately optimistic reviewer text: jean-ci must still fail closed on expiry/deny.
        answer = 'VERDICT: PASS\nFixture review complete.\n- Review profile: diff=reviewed; repository=inspected; tests=not needed.'
        execution_result.get()['result'] = {'final_response': answer, 'completed': True}
        return answer

    runner._handle_message = handle
    @web.middleware
    async def trace(request, handler):
        response = await handler(request)
        if response.status >= 400:
            import sys
            print(f'fixture HTTP {request.method} {request.path}: {response.status} {response.text}', file=sys.stderr, flush=True)
        return response

    app = web.Application(middlewares=[trace])
    app.router.add_get('/v1/capabilities', api._handle_capabilities)
    app.router.add_post('/v1/runs', api._handle_runs)
    app.router.add_get('/v1/runs/{run_id}', api._handle_get_run)
    app.router.add_post('/v1/runs/{run_id}/approval', api._handle_run_approval)

    async def expire(request):
        sid = (await request.json())['run_id']
        if sid not in authority.sessions:
            raise web.HTTPNotFound()
        with approval._lock:
            entries = approval._gateway_queues.get(sid, [])
            count = len(entries)
            prompt_id = entries[0].data['request_id'] if entries else None
        clock_offset[0] += 1801
        # Baseline arbitrates first settlement, not an extension-only entry.deadline.
        # Wait for actual native expiry/removal before trying the old exact once.
        for _ in range(200):
            if sid in outcomes:
                break
            await asyncio.sleep(0.01)
        assert outcomes.get(sid) == {'resolved': False, 'choice': None}
        resolved = approval.resolve_gateway_approval(sid, 'once', request_id=prompt_id) if prompt_id else 0
        return web.json_response({'advanced': count, 'resolved': resolved})

    async def evidence(_request):
        return web.json_response(outcomes)

    app.router.add_post('/_fixture/expire', expire)
    app.router.add_get('/_fixture/evidence', evidence)
    server = web.AppRunner(app)
    await server.setup()
    site = web.TCPSite(server, '127.0.0.1', 0)
    await site.start()
    print(json.dumps({'port': site._server.sockets[0].getsockname()[1]}), flush=True)
    stopped = asyncio.Event()
    import signal
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stopped.set)
    try:
        await stopped.wait()
    finally:
        with approval._lock:
            for sid in list(authority.sessions):
                for entry in approval._gateway_queues.get(sid, []):
                    entry.cancelled = 'fixture teardown'
                    entry.event.set()
        await server.cleanup()
        if api._background_tasks:
            await asyncio.gather(*api._background_tasks, return_exceptions=True)
        api._response_store.close()
        api._run_idempotency_store.close()
        db.close()


asyncio.run(main())
