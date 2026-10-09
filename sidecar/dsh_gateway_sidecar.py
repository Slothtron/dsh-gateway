#!/usr/bin/env python3
"""NDJSON stdio sidecar bridging octop-gateway to the DSH dsh-gateway plugin.

Protocol (one JSON object per line, UTF-8, both directions):

Parent -> sidecar (request/response, correlated by ``mid``):
  {"op":"hello","mid":1}
  {"op":"introspect","mid":2}
  {"op":"add_channel","mid":3,"channel_id":"...","kind":"feishu","config":{...},"secrets":{...}}
  {"op":"remove_channel","mid":4,"channel_id":"..."}
  {"op":"test_channel","mid":5,"kind":"feishu","config":{...},"secrets":{...}}
  {"op":"push_text","mid":6,"channel_id":"...","subject":{...},"text":"..."}
  {"op":"reply","rid":"...","events":[{"type":"MESSAGE","text":"..."}]}   # no mid
  {"op":"shutdown"}

Sidecar -> parent:
  {"mid":3,"ok":true,...} | {"mid":3,"ok":false,"error":"..."}
  {"op":"inbound","rid":"...","channel_id":"...","subject":{...},"text":"...","msg_id":"..."}
  {"op":"status","channels":[{"channel_id":"...","connected":true}]}

The plugin is the session owner: the processor below forwards every normalized
inbound message to the parent and yields the events the parent sends back on
the reply op. Rate limiting, dedup, typing keepalive and group policy all stay
inside octop-gateway (BaseChannel.handle_inbound owns them).
"""

from __future__ import annotations

import asyncio
import dataclasses
import importlib
import importlib.metadata
import json
import faulthandler
import logging
import os
import signal
import sys
import tempfile
import threading
import uuid
from collections.abc import AsyncIterator
from typing import Any

from octop_gateway import ChannelManager, MessageEvent
from octop_gateway.channel import ChannelConfig
from octop_gateway.channels import _CHANNEL_MAP
from octop_gateway.media import FileSystemMediaBackend
from octop_gateway.models import ChannelSubject

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(name)s %(levelname)s %(message)s")
# Debug aid: kill -USR1 <pid> dumps all thread stacks to stderr.
faulthandler.register(signal.SIGUSR1, all_threads=True)
logger = logging.getLogger("dsh_gateway_sidecar")

REPLY_WAIT_TIMEOUT = 300.0
TEST_WAIT_TIMEOUT = 12.0
STATUS_INTERVAL = 5.0
BASE_CONFIG_FIELDS = {"channel_id", "tenant_id"}
SECRET_MARKERS = ("secret", "token", "password", "api_key")


def _is_secret(name: str) -> bool:
    lowered = name.lower()
    return any(marker in lowered for marker in SECRET_MARKERS)


def _config_class_for(kind: str) -> type:
    module = importlib.import_module(_CHANNEL_MAP[kind])
    for attr in dir(module):
        obj = getattr(module, attr)
        if dataclasses.is_dataclass(obj) and isinstance(obj, type) and issubclass(obj, ChannelConfig) and obj is not ChannelConfig:
            return obj
    raise KeyError(f"no ChannelConfig dataclass found for kind {kind!r}")


def _introspect() -> list[dict[str, Any]]:
    kinds: list[dict[str, Any]] = []
    for kind in _CHANNEL_MAP:
        cfg = _config_class_for(kind)
        fields = []
        for f in dataclasses.fields(cfg):
            if f.name in BASE_CONFIG_FIELDS:
                continue
            has_default = f.default is not dataclasses.MISSING or f.default_factory is not dataclasses.MISSING
            default = None
            default_is_bool = False
            default_is_int = False
            if f.default is not dataclasses.MISSING:
                default = f.default
            elif f.default_factory is not dataclasses.MISSING:
                try:
                    default = f.default_factory()
                except Exception:
                    default = None
            if isinstance(default, bool):
                default_is_bool = True
            elif isinstance(default, int):
                default_is_int = True
            fields.append(
                {
                    "name": f.name,
                    "required": not has_default,
                    "secret": _is_secret(f.name),
                    "boolDefault": default_is_bool,
                    "defaultBool": default if default_is_bool else None,
                    "intDefault": default_is_int,
                }
            )
        kinds.append({"kind": kind, "fields": fields})
    return kinds


def _coerce_config(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Coerce form-originated string values to the config dataclass's defaults' types."""
    try:
        cfg = _config_class_for(kind)
    except KeyError:
        return dict(raw)
    coerced = dict(raw)
    for f in dataclasses.fields(cfg):
        if f.name not in coerced or coerced[f.name] is None:
            continue
        value = coerced[f.name]
        default = f.default if f.default is not dataclasses.MISSING else None
        if isinstance(default, bool):
            if isinstance(value, str):
                lowered = value.strip().lower()
                if lowered in ("true", "1", "yes"):
                    coerced[f.name] = True
                elif lowered in ("false", "0", "no", ""):
                    coerced[f.name] = False
        elif isinstance(default, int) and not isinstance(default, bool):
            try:
                coerced[f.name] = int(value)
            except (TypeError, ValueError):
                pass
    return coerced


async def _noop_processor(_message: Any) -> AsyncIterator[MessageEvent]:
    yield MessageEvent.completed()


class Bridge:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.manager: ChannelManager | None = None
        self.replies: dict[str, asyncio.Future] = {}
        self.stdin_queue: asyncio.Queue[str | None] = asyncio.Queue()
        self._stopped = False

    # ------------------------------------------------------------------ io

    def write(self, obj: dict[str, Any]) -> None:
        try:
            sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + "\n")
            sys.stdout.flush()
        except Exception:  # pragma: no cover - stdout closed during shutdown
            logger.exception("failed to write stdout frame")

    async def _stdin_pump(self) -> None:
        """Pump stdin into the loop queue from a plain daemon thread.

        Deliberately NOT asyncio.to_thread: asyncio.run joins its default
        executor at close, and a pump blocked in a stdin read would deadlock
        interpreter exit. A daemon thread is ignored at exit instead.
        """
        loop = self.loop

        def pump() -> None:
            try:
                for line in sys.stdin:
                    loop.call_soon_threadsafe(self.stdin_queue.put_nowait, line)
                loop.call_soon_threadsafe(self.stdin_queue.put_nowait, None)
            except Exception:
                loop.call_soon_threadsafe(self.stdin_queue.put_nowait, None)

        threading.Thread(target=pump, name="dsh-gateway-stdin-pump", daemon=True).start()
        await asyncio.Event().wait()

    # ------------------------------------------------------------- manager

    async def _ensure_manager(self) -> ChannelManager:
        if self.manager is None:
            data_dir = os.environ.get("DSH_GATEWAY_DATA_DIR") or os.path.join(tempfile.gettempdir(), "dsh-gateway")
            os.makedirs(data_dir, exist_ok=True)
            self.manager = ChannelManager(processor=self.processor, media_backend=FileSystemMediaBackend(data_dir))
            await self.manager.start()
        return self.manager

    def _connection_state(self, channel_id: str) -> bool:
        if self.manager is None:
            return False
        channel = self.manager.get_channel(channel_id)
        if channel is None:
            return False
        # Channels are inconsistent about their ready flag: discord/xiaoyi/
        # mqtt/telegram set _connection_session, feishu sets _ws_session_id.
        for attr in ("_connection_session", "_ws_session_id"):
            if getattr(channel, attr, None):
                return True
        return False

    def push_status(self) -> None:
        if self.manager is None:
            return
        channels = [
            {"channel_id": cid, "connected": self._connection_state(cid)}
            for cid in list(getattr(self.manager, "_channels", {}).keys())
        ]
        self.write({"op": "status", "channels": channels})

    async def _status_loop(self) -> None:
        try:
            while True:
                await asyncio.sleep(STATUS_INTERVAL)
                self.push_status()
        except asyncio.CancelledError:
            raise

    # ----------------------------------------------------------- processor

    async def processor(self, msg: Any) -> AsyncIterator[MessageEvent]:
        """Forward one inbound message to the plugin and yield its reply events."""
        rid = str(uuid.uuid4())
        future: asyncio.Future = self.loop.create_future()
        self.replies[rid] = future
        subject = msg.channel_subject
        text = "\n".join(part.text for part in (msg.content or []) if getattr(part, "text", None))
        metadata = subject.metadata or {}
        self.write(
            {
                "op": "inbound",
                "rid": rid,
                "channel_id": msg.channel_id,
                "subject": {
                    "subject_id": subject.subject_id,
                    "display_name": subject.display_name,
                    "chat_type": subject.chat_type,
                    "metadata": {k: v for k, v in metadata.items() if isinstance(v, (str, int, float, bool))},
                },
                "text": text,
                "msg_id": (msg.metadata or {}).get("msg_id"),
            }
        )
        try:
            reply = await asyncio.wait_for(future, timeout=REPLY_WAIT_TIMEOUT)
        except asyncio.TimeoutError:
            reply = {"events": [{"type": "MESSAGE", "text": "⏳ bridge reply timeout, please retry later"}]}
        finally:
            self.replies.pop(rid, None)

        if reply.get("error"):
            yield MessageEvent.text(f"[bridge error] {reply['error']}")
        else:
            for event in reply.get("events", []):
                if event.get("type") == "MESSAGE":
                    yield MessageEvent.text(str(event.get("text", "")))
        yield MessageEvent.completed()

    # ----------------------------------------------------------------- ops

    async def handle(self, msg: dict[str, Any]) -> bool:
        """Dispatch one op. Returns False when the sidecar should exit."""
        op = msg.get("op")
        mid = msg.get("mid")
        try:
            if op == "hello":
                version = "unknown"
                try:
                    version = importlib.metadata.version("octop-gateway")
                except Exception:
                    pass
                self.write({"mid": mid, "ok": True, "gateway_version": version, "kinds": sorted(_CHANNEL_MAP)})
            elif op == "introspect":
                self.write({"mid": mid, "ok": True, "kinds": _introspect()})
            elif op == "add_channel":
                manager = await self._ensure_manager()
                merged = {**(msg.get("config") or {}), **(msg.get("secrets") or {})}
                channel_id = str(msg["channel_id"])
                try:
                    channel_id = await manager.add_channel(
                        channel_type=str(msg["kind"]),
                        config=_coerce_config(str(msg["kind"]), merged),
                        channel_id=channel_id,
                    )
                except Exception:
                    # Roll back any partially registered channel so a failed
                    # add cannot wedge manager.stop() later.
                    channel = manager.get_channel(channel_id)
                    if channel is not None:
                        manager._channels.pop(channel_id, None)
                        try:
                            await asyncio.wait_for(channel.stop(), 5.0)
                        except Exception:
                            logger.warning("rollback stop of channel %s failed", channel_id)
                    raise
                self.write({"mid": mid, "ok": True, "channel_id": channel_id})
                self.push_status()
            elif op == "remove_channel":
                if self.manager is not None:
                    channel = self.manager.get_channel(str(msg["channel_id"]))
                    if channel is not None:
                        await channel.stop()
                        self.manager._channels.pop(str(msg["channel_id"]), None)
                self.write({"mid": mid, "ok": True})
                self.push_status()
            elif op == "test_channel":
                detail = await self._test_channel(str(msg["kind"]), msg)
                self.write({"mid": mid, "ok": True, **detail})
            elif op == "push_text":
                if self.manager is None:
                    raise RuntimeError("gateway manager not started")
                channel = self.manager.get_channel(str(msg["channel_id"]))
                if channel is None:
                    raise ValueError(f"channel not found: {msg['channel_id']}")
                subject_payload = msg.get("subject") or {}
                subject = ChannelSubject(
                    subject_id=str(subject_payload.get("subject_id", "")),
                    display_name=str(subject_payload.get("display_name", "")),
                    chat_type=str(subject_payload.get("chat_type", "")),
                    metadata=dict(subject_payload.get("metadata") or {}),
                )
                await channel.push_text(subject, str(msg["text"]))
                self.write({"mid": mid, "ok": True})
            elif op == "reply":
                future = self.replies.get(str(msg.get("rid")))
                if future is not None and not future.done():
                    future.set_result(msg)
            elif op == "shutdown":
                self.write({"mid": mid, "ok": True})
                return False
            else:
                self.write({"mid": mid, "ok": False, "error": f"unknown op: {op!r}"})
        except Exception as error:
            logger.exception("op %s failed", op)
            self.write({"mid": mid, "ok": False, "error": str(error)})
        return True

    async def _test_channel(self, kind: str, msg: dict[str, Any]) -> dict[str, Any]:
        merged = {**(msg.get("config") or {}), **(msg.get("secrets") or {})}
        config = _coerce_config(kind, merged)
        data_dir = os.environ.get("DSH_GATEWAY_DATA_DIR") or os.path.join(tempfile.gettempdir(), "dsh-gateway")
        os.makedirs(data_dir, exist_ok=True)
        manager = ChannelManager(processor=_noop_processor, media_backend=FileSystemMediaBackend(os.path.join(data_dir, "test")))
        channel_id = str(uuid.uuid4())
        connected = False
        detail = "no ready event within timeout"
        try:
            await manager.start()
            await manager.add_channel(channel_type=kind, config=config, channel_id=channel_id)
            deadline = self.loop.time() + TEST_WAIT_TIMEOUT
            while self.loop.time() < deadline:
                channel = manager.get_channel(channel_id)
                if channel is not None and any(
                    getattr(channel, attr, None) for attr in ("_connection_session", "_ws_session_id")
                ):
                    connected = True
                    detail = "connected"
                    break
                await asyncio.sleep(0.5)
        except Exception as error:
            detail = f"start failed: {error}"
        finally:
            try:
                await manager.stop()
            except Exception:
                logger.exception("test manager stop failed")
        return {"connected": connected, "detail": detail}

    # ------------------------------------------------------------- shutdown

    async def shutdown(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        if self.manager is not None:
            try:
                await asyncio.wait_for(self.manager.stop(), timeout=15.0)
            except Exception:
                logger.exception("manager stop failed or timed out; abandoning cleanup")
            self.manager = None


async def main() -> None:
    bridge = Bridge()
    pump = asyncio.create_task(bridge._stdin_pump())
    status_task = asyncio.create_task(bridge._status_loop())
    try:
        while True:
            line = await bridge.stdin_queue.get()
            if line is None:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("skipping malformed stdin frame: %.120s", line)
                continue
            if not await bridge.handle(msg):
                break
    finally:
        status_task.cancel()
        pump.cancel()
        await bridge.shutdown()


if __name__ == "__main__":
    code = 0
    try:
        asyncio.run(main())
    except Exception:
        logger.exception("sidecar main loop crashed")
        code = 1
    finally:
        # Some platform SDKs (e.g. paho-mqtt network threads) leave non-daemon
        # threads that block interpreter exit; the parent owns our lifecycle,
        # so force-exit after bounded cleanup. stdout frames are flushed per
        # write, so nothing is lost.
        os._exit(code)
