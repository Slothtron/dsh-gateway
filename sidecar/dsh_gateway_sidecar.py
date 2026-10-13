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
import time
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

from octop_gateway import ChannelManager, MessageEvent
from octop_gateway.channel import ChannelConfig
from octop_gateway.channels import _CHANNEL_MAP
from octop_gateway.group_context import GroupContextConfig
from octop_gateway.media import FileSystemMediaBackend
from octop_gateway.models import ChannelSubject

logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(name)s %(levelname)s %(message)s")
# Debug aid: kill -USR1 <pid> dumps all thread stacks to stderr.
faulthandler.register(signal.SIGUSR1, all_threads=True)
logger = logging.getLogger("dsh_gateway_sidecar")

REPLY_WAIT_TIMEOUT = 300.0
TEST_WAIT_TIMEOUT = 12.0
STATUS_INTERVAL = 5.0
# Scan-to-create: overall budget, how long one waiting window lasts (the page
# always shows the code of the current window), and how many times an expired
# code may be replaced before the session is reported as expired.
QR_TIMEOUT_S = 480.0
QR_WINDOW_S = 100.0
QR_MAX_REFRESH = 3
BASE_CONFIG_FIELDS = {"channel_id", "tenant_id"}

# The channel catalogue: which kinds are offered, and for each one the controls
# the settings page shows (name / label / type / required / secret). It lives in
# the language-neutral contract under core/spec/, so this sidecar must NOT keep a
# second copy of it. Field *defaults* are deliberately absent from the file: they
# are read from the installed octop-gateway dataclasses, so a version bump cannot
# leave them stale.
SPEC_PATH = Path(__file__).resolve().parent.parent / "core" / "spec" / "channels.json"


def _load_spec() -> dict[str, Any]:
    try:
        spec = json.loads(SPEC_PATH.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise RuntimeError(f"channel spec missing: {SPEC_PATH}") from error
    except json.JSONDecodeError as error:
        raise RuntimeError(f"channel spec is not valid JSON: {SPEC_PATH}: {error}") from error
    if not isinstance(spec.get("kinds"), dict) or not spec["kinds"]:
        raise RuntimeError(f"channel spec declares no kinds: {SPEC_PATH}")
    return spec


SPEC = _load_spec()


def _config_class_for(kind: str) -> type:
    module = importlib.import_module(_CHANNEL_MAP[kind])
    for attr in dir(module):
        obj = getattr(module, attr)
        if dataclasses.is_dataclass(obj) and isinstance(obj, type) and issubclass(obj, ChannelConfig) and obj is not ChannelConfig:
            return obj
    raise KeyError(f"no ChannelConfig dataclass found for kind {kind!r}")


def _default_value(field: Any) -> Any:
    """One field's declared default, with a nested config flattened to a dict."""
    if field.default is not dataclasses.MISSING:
        value = field.default
    elif field.default_factory is not dataclasses.MISSING:  # type: ignore[misc]
        try:
            value = field.default_factory()  # type: ignore[misc]
        except Exception:
            return None
    else:
        return None
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return dataclasses.asdict(value)
    return value


def _kind_defaults(kind: str) -> dict[str, Any]:
    """Every editable key's default, straight from the installed channel config."""
    defaults: dict[str, Any] = {}
    for field in dataclasses.fields(_config_class_for(kind)):
        if field.name in BASE_CONFIG_FIELDS:
            continue
        defaults[field.name] = _default_value(field)
    return defaults


def _accepted_keys(kind: str) -> set[str]:
    """Config keys octop-gateway accepts: declared fields, aliases, and any key
    the spec declares separately (a channel whose ``from_dict`` takes a flat
    form the dataclass does not name, e.g. weixin's single-account shorthand)."""
    cfg = _config_class_for(kind)
    keys = {field.name for field in dataclasses.fields(cfg)}
    keys |= set(getattr(cfg, "field_aliases", {}) or {})
    keys |= set(SPEC["kinds"][kind].get("acceptsExtraKeys", []) or [])
    return keys


def _kind_entry(kind: str) -> dict[str, Any]:
    """One kind's settings-page schema: groups of controls carrying live defaults."""
    entry = SPEC["kinds"][kind]
    defaults = _kind_defaults(kind)
    accepted = _accepted_keys(kind)
    drift = [c["name"] for c in entry["connection"] if c["name"] not in accepted]

    groups: list[dict[str, Any]] = [{
        "id": "connection",
        "title": "连接配置",
        "description": "这个平台怎么接入 DSH；凭据只进 DSH 凭据库，页面不回显已保存的值。",
        # The page orders its cards by `order`: the host-side session card in
        # client.js sits at 20, the catalogue's own groups at 30 and 40.
        "order": 10,
        "controls": [
            {
                **control,
                "secret": bool(control.get("secret")),
                "required": bool(control.get("required")),
                "default": defaults.get(control["name"]),
            }
            for control in entry["connection"]
        ],
    }]

    for group in SPEC["groups"]:
        # A group may declare which kinds it applies to: a control that a
        # platform cannot honour (a group policy where the platform has no group
        # surface) is not offered at all, rather than offered and inert.
        allow = group.get("kinds")
        if allow is not None and kind not in allow:
            continue
        path = group.get("path")
        nested = defaults.get(path) if path else None
        if path and not isinstance(nested, dict):
            nested = {}
        if path:
            known = {f.name for f in dataclasses.fields(GroupContextConfig)}
            drift += [c["name"] for c in group["controls"] if c["name"] not in known]
        built = {key: value for key, value in group.items() if key in ("id", "title", "description", "path", "order")}
        notice = (group.get("kindNotices") or {}).get(kind)
        if notice:
            built["notice"] = notice
        built["controls"] = [
            {
                **control,
                "default": (
                    (nested or {}).get(control["name"], control.get("default"))
                    if path
                    else defaults.get(control["name"], control.get("default"))
                ),
            }
            for control in group["controls"]
        ]
        groups.append(built)

    return {
        "kind": kind,
        "label": entry["label"],
        # The control whose value identifies the account on the platform. The
        # host uses it to recognize "this account is already configured" instead
        # of adding a second channel that polls the same bot.
        "identity": entry.get("identity"),
        # One-line description for the platform tile in the settings page.
        "blurb": entry.get("blurb"),
        "color": entry.get("color"),
        "credentialUrl": entry.get("credentialUrl"),
        # The scan-to-create declaration, when this kind has a QR login flow.
        "quickConfig": _qr_quick_config(kind),
        "fixed": entry.get("fixed", {}),
        "defaults": defaults,
        "groups": groups,
        "drift": drift,
    }


def _introspect() -> dict[str, Any]:
    """The settings page's channel schema: offered kinds, their groups, and drift."""
    kinds: list[dict[str, Any]] = []
    problems: list[str] = []
    for kind in SPEC["kinds"]:
        if kind not in _CHANNEL_MAP:
            problems.append(f"spec offers kind {kind!r}, which the installed octop-gateway does not provide")
            continue
        try:
            entry = _kind_entry(kind)
        except Exception as error:  # noqa: BLE001 - report drift, never break the page
            problems.append(f"kind {kind!r} introspection failed: {error}")
            continue
        for name in entry["drift"]:
            problems.append(f"{kind}: spec control {name!r} is not accepted by the channel config")
        kinds.append(entry)
    if problems:
        logger.warning("channel spec drift: %s", "; ".join(problems))
    return {"kinds": kinds, "drift": problems}


def _coerce_config(kind: str, raw: dict[str, Any]) -> dict[str, Any]:
    """Make a JSON config fit the channel's config dataclass.

    Two jobs: coerce form-originated strings to the declaration's types, and turn
    a ``group_context`` mapping into a real :class:`GroupContextConfig`. The
    second is not redundant with the gateway's own ``from_dict``: a channel that
    overrides ``from_dict`` without calling ``super()`` (weixin) would otherwise
    hand a bare dict to ``GroupContextManager``, which reads ``.resolve()`` on it
    and fails on the first inbound message.
    """
    try:
        cfg = _config_class_for(kind)
    except KeyError:
        return dict(raw)
    coerced = dict(raw)
    group_context = coerced.get("group_context")
    if isinstance(group_context, dict):
        coerced["group_context"] = GroupContextConfig.from_dict(group_context)
    elif group_context is None and "group_context" in coerced:
        coerced.pop("group_context")
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


def _render_inbound_text(msg: Any) -> str:
    """Flatten one inbound message into the text the agent sees.

    Passive group chatter does NOT live in ``msg.content``: the channel's
    ``GroupContextManager`` buffers it and attaches it as ``msg.group_context``,
    and rendering that is the processor's job (octop-gateway keeps the durable
    thread clean on purpose). Without this step a channel's 群聊策略 would be
    inert — the user configures "mentions + recent messages" and the agent only
    ever sees the triggering line.

    DM traffic has no group context, so this reduces to the message text.
    """
    current = "\n".join(part.text for part in (msg.content or []) if getattr(part, "text", None))
    context = getattr(msg, "group_context", None)
    buffered = getattr(context, "messages", None) if context is not None else None
    if not buffered:
        return current

    labels: dict[str, str] = {}

    def label_of(sender_id: str, sender_name: str) -> str:
        safe_id = " ".join(str(sender_id or "").split()) or "unknown"
        safe_name = " ".join(str(sender_name or "").split())
        if safe_name and safe_name != safe_id:
            return safe_name
        if safe_id not in labels:
            labels[safe_id] = f"群成员{len(labels) + 1}"
        return labels[safe_id]

    meta = getattr(msg, "metadata", None) or {}
    lines = ["【群聊背景｜仅供参考】"]
    for item in buffered:
        body = str(getattr(item, "text", "") or "")
        body_lines = body.splitlines() or [""]
        lines.append(f"[{label_of(getattr(item, 'sender_id', ''), getattr(item, 'sender_name', ''))}] {body_lines[0]}")
        lines.extend(f"  {line}" for line in body_lines[1:])
    lines.append("")
    lines.append("【当前群消息｜请回复这条】")
    lines.append(f"[{label_of(meta.get('sender_id', ''), meta.get('sender_name', ''))}] {current}")
    return "\n".join(lines)


def _qr_quick_config(kind: str) -> dict[str, Any] | None:
    """The kind's scan-to-create declaration, when the catalogue offers one."""
    config = SPEC["kinds"].get(kind, {}).get("quickConfig")
    if not isinstance(config, dict) or config.get("mode") != "qr":
        return None
    return config


def _qr_credentials_to_controls(kind: str, credentials: dict[str, Any]) -> dict[str, Any]:
    """Map the gateway's credential keys onto this catalogue's control names.

    The mapping is platform knowledge and stays here: the settings page applies
    whatever it is handed, keyed by control name.
    """
    def keep(pairs: dict[str, Any]) -> dict[str, str]:
        return {name: str(value) for name, value in pairs.items() if value}

    if kind == "qq":
        return {
            "fills": keep({"app_id": credentials.get("app_id")}),
            "secrets": keep({"secret": credentials.get("app_secret")}),
        }
    if kind == "weixin":
        return {
            "fills": keep({
                "bot_uin": credentials.get("account_id"),
                "base_url": credentials.get("base_url"),
            }),
            "secrets": keep({"token": credentials.get("bot_token")}),
        }
    return {"fills": {}, "secrets": {}}


# Liveness signals, most specific first. There is no public "am I connected"
# API and the channels disagree: discord/xiaoyi/telegram keep a `_connection_session`,
# feishu a `_ws_session_id`, QQ a gateway `_session_id_ws`. Every kind this
# catalogue offers instead flips `_running` in start()/stop(), so that flag is
# the signal to trust first. Checking only the session handles reported
# 微信 / QQ / 钉钉 as offline while they were happily sending and receiving.
_LIVENESS_SESSION_ATTRS = (
    "_connection_session",
    "_ws_session_id",
    "_session_id_ws",
    "_stream_session_id",
)


def _channel_ready(channel: Any) -> bool:
    """Whether one channel is up, from the strongest signal it exposes."""
    running = getattr(channel, "_running", None)
    if running is False:
        return False
    if running is True:
        return True
    # No `_running` flag at all: fall back to a live session handle.
    return any(getattr(channel, attr, None) for attr in _LIVENESS_SESSION_ATTRS)


def _weixin_session_paused(channel: Any) -> bool:
    """Whether 微信 has been told its login session is gone.

    The long-poll channel keeps `_running` true while the platform rejected the
    session (`errcode -14`): it stops polling that account for a while and
    expects a fresh QR scan. That is a different state from "still connecting",
    and the only place it is recorded is the per-account resume time, so read it
    rather than reporting a paused account as healthy.
    """
    pauses = getattr(channel, "_session_pause_until", None)
    if not isinstance(pauses, dict):
        return False
    now = time.monotonic()
    return any(isinstance(until, (int, float)) and until > now for until in pauses.values())


def _channel_status(channel: Any) -> dict[str, Any]:
    """One channel's live state as `{connected, reason, detail}`.

    `reason` is a locale-neutral code; the host decides how to say it. A
    registered-but-not-yet-up channel is `connecting`, which is not the same
    fact as "failed to start" — the host owns that one, because only it knows
    whether the registration itself threw.
    """
    if _weixin_session_paused(channel):
        return {"connected": False, "reason": "session-expired", "detail": "weixin login session expired"}
    if _channel_ready(channel):
        return {"connected": True, "reason": None, "detail": None}
    return {"connected": False, "reason": "connecting", "detail": None}


async def _noop_processor(_message: Any) -> AsyncIterator[MessageEvent]:
    yield MessageEvent.completed()


class Bridge:
    def __init__(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.manager: ChannelManager | None = None
        self.replies: dict[str, asyncio.Future] = {}
        self.stdin_queue: asyncio.Queue[str | None] = asyncio.Queue()
        # Scan-to-create sessions, keyed by the id handed to the settings page.
        # They live here because the gateway's login objects hold one-time keys
        # and refresh counters in memory, and because any credentials they return
        # must never be persisted.
        self.qr_sessions: dict[str, dict[str, Any]] = {}
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
        return _channel_ready(channel)

    def push_status(self) -> None:
        if self.manager is None:
            return
        channels = []
        for cid in list(getattr(self.manager, "_channels", {}).keys()):
            channel = self.manager.get_channel(cid)
            if channel is None:
                continue
            channels.append({"channel_id": cid, **_channel_status(channel)})
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
        text = _render_inbound_text(msg)
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

    # ------------------------------------------------------------------- qr

    async def _qr_start(self, kind: str) -> dict[str, Any]:
        """Begin one scan-to-create session and return what the page must show."""
        if _qr_quick_config(kind) is None:
            raise ValueError(f"kind {kind!r} has no scan-to-create flow")
        session: dict[str, Any] = {
            "kind": kind,
            "status": "waiting",
            "url": None,
            "fills": None,
            "secrets": None,
            "message": None,
            "task": None,
        }
        if kind == "qq":
            from octop_gateway.channels.qq.login_qr import QQBotQRLogin

            login = QQBotQRLogin()
            created = await login.fetch_qr_code()
            session["login"] = login
            session["token"] = created.task_id
            session["url"] = created.qrcode_url
        elif kind == "weixin":
            from octop_gateway.channels.weixin.login_qr import WeixinQRLogin

            login = WeixinQRLogin()
            created = await login.fetch_qr_code()
            session["login"] = login
            session["token"] = created.qrcode
            session["url"] = created.qrcode_img_content
            # The library's own waiting loop refreshes an expired code WITHOUT
            # telling the caller, which would leave the page showing a dead code
            # while the backend polls a new one. Run bounded windows instead and
            # drive every refresh from here, so the page always shows a live code.
            session["task"] = asyncio.create_task(self._weixin_qr_loop(session))
        else:  # pragma: no cover - the catalogue gate above decides reachability
            raise ValueError(f"kind {kind!r} has no scan-to-create flow")

        task_id = uuid.uuid4().hex
        self.qr_sessions[task_id] = session
        logger.info("qr: started %s session %s", kind, task_id)
        return {"task_id": task_id, "kind": kind, "url": session["url"], "expires_in_s": QR_TIMEOUT_S}

    async def _weixin_qr_loop(self, session: dict[str, Any]) -> None:
        """Own a WeChat QR session: wait in windows, refresh the code between them."""
        login = session["login"]
        deadline = self.loop.time() + QR_TIMEOUT_S
        refreshes = 0
        while not self._stopped and self.loop.time() < deadline:
            try:
                result = await login.wait_for_login(
                    session["token"],
                    timeout_s=QR_WINDOW_S,
                    on_scanned=lambda: session.update(status="scanned"),
                )
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 - surfaced to the page
                logger.warning("qr: weixin wait failed: %s", error)
                session.update(status="error", message=str(error))
                return
            if result.connected:
                mapped = _qr_credentials_to_controls("weixin", {
                    "account_id": result.account_id,
                    "bot_token": result.bot_token,
                    "base_url": result.base_url,
                })
                session.update(status="success", fills=mapped["fills"], secrets=mapped["secrets"])
                logger.info("qr: weixin session confirmed")
                return
            if refreshes >= QR_MAX_REFRESH:
                session.update(status="expired", message=result.message or "二维码已过期")
                return
            refreshes += 1
            try:
                refreshed = await login.fetch_qr_code()
            except Exception as error:  # noqa: BLE001 - surfaced to the page
                logger.warning("qr: weixin refresh failed: %s", error)
                session.update(status="error", message=str(error))
                return
            session.update(token=refreshed.qrcode, url=refreshed.qrcode_img_content, status="waiting")
            logger.info("qr: weixin session refreshed (%d/%d)", refreshes, QR_MAX_REFRESH)
        if session.get("status") not in ("success", "error", "expired"):
            session.update(status="expired", message="二维码登录超时")

    async def _qr_poll(self, task_id: str) -> dict[str, Any]:
        """One status read. Credentials are handed out exactly once."""
        session = self.qr_sessions.get(task_id)
        if session is None:
            return {"status": "unknown"}
        if session["kind"] == "qq" and session["status"] in ("waiting", "scanned"):
            try:
                result = await session["login"].poll(session["token"])
            except Exception as error:  # noqa: BLE001 - surfaced to the page
                session.update(status="error", message=str(error))
            else:
                if result.status == "success" and result.credentials:
                    credential = result.credentials[0]
                    mapped = _qr_credentials_to_controls("qq", {
                        "app_id": credential.app_id,
                        "app_secret": credential.app_secret,
                    })
                    session.update(status="success", fills=mapped["fills"], secrets=mapped["secrets"])
                    logger.info("qr: qq session confirmed")
                elif result.status == "expired":
                    session.update(status="expired", message="二维码已过期")

        payload: dict[str, Any] = {
            "status": session["status"],
            "url": session["url"],
            "message": session.get("message"),
        }
        if session["status"] == "success" and not session.get("delivered"):
            session["delivered"] = True
            payload["fills"] = session["fills"] or {}
            payload["secrets"] = session["secrets"] or {}
            # Never hand the same credentials out twice, and never keep them
            # longer than the page needs them.
            session["fills"] = None
            session["secrets"] = None
            logger.info("qr: credentials delivered for session %s", task_id)
        return payload

    def _qr_cancel(self, task_id: str) -> None:
        session = self.qr_sessions.pop(task_id, None)
        if session is None:
            return
        task = session.get("task")
        if task is not None:
            task.cancel()
        logger.info("qr: cancelled session %s", task_id)

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
                self.write({
                    "mid": mid,
                    "ok": True,
                    "gateway_version": version,
                    # `kinds` stays the catalogue this sidecar actually serves;
                    # `gateway_kinds` is what the installed gateway could build.
                    "kinds": sorted(SPEC["kinds"]),
                    "gateway_kinds": sorted(_CHANNEL_MAP),
                })
            elif op == "introspect":
                self.write({"mid": mid, "ok": True, **_introspect()})
            elif op == "add_channel":
                manager = await self._ensure_manager()
                kind = str(msg["kind"])
                merged = {**(msg.get("config") or {}), **(msg.get("secrets") or {})}
                # A spec-declared `fixed` map pins values the platform must not be
                # configured out of (e.g. QQ needs its C2C stream on).
                merged.update(SPEC["kinds"].get(kind, {}).get("fixed") or {})
                channel_id = str(msg["channel_id"])
                try:
                    channel_id = await manager.add_channel(
                        channel_type=kind,
                        config=_coerce_config(kind, merged),
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
            elif op == "qr_start":
                self.write({"mid": mid, "ok": True, **await self._qr_start(str(msg["kind"]))})
            elif op == "qr_poll":
                self.write({"mid": mid, "ok": True, **await self._qr_poll(str(msg["task_id"]))})
            elif op == "qr_cancel":
                self._qr_cancel(str(msg["task_id"]))
                self.write({"mid": mid, "ok": True})
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
        reason = "timeout"
        detail = "no ready event within timeout"
        try:
            await manager.start()
            await manager.add_channel(channel_type=kind, config=config, channel_id=channel_id)
            deadline = self.loop.time() + TEST_WAIT_TIMEOUT
            while self.loop.time() < deadline:
                channel = manager.get_channel(channel_id)
                # Same probe the status loop uses, so "测试连接" and the card
                # can never disagree about what "connected" means.
                if channel is not None and _channel_ready(channel):
                    connected = True
                    reason = None
                    detail = "connected"
                    break
                await asyncio.sleep(0.5)
        except Exception as error:
            reason = "error"
            detail = f"start failed: {error}"
        finally:
            try:
                await manager.stop()
            except Exception:
                logger.exception("test manager stop failed")
        return {"connected": connected, "reason": reason, "detail": detail}

    # ------------------------------------------------------------- shutdown

    async def shutdown(self) -> None:
        if self._stopped:
            return
        self._stopped = True
        for session in self.qr_sessions.values():
            task = session.get("task")
            if task is not None:
                task.cancel()
        self.qr_sessions.clear()
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
