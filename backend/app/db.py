"""Transactional JSONB ledger; SQLite uses the same schema for local development.

Every write takes a workspace transaction lock. This makes idempotency, concurrent
run limits, graph revisions, event sequencing and job claims atomic across API and
worker processes. Provider calls always happen outside database transactions.
"""

import base64
import hashlib
import json
from contextlib import contextmanager
from copy import deepcopy
from datetime import UTC, datetime
from uuid import uuid4

from sqlalchemy import (
    JSON,
    Column,
    Index,
    Integer,
    MetaData,
    String,
    Table,
    and_,
    create_engine,
    delete,
    event,
    insert,
    select,
    text,
    update,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.pool import StaticPool

from app.errors import APIError, invalid, not_found

metadata = MetaData()
document = JSON().with_variant(JSONB(), "postgresql")
resources = Table(
    "resources",
    metadata,
    Column("workspace", String(200), primary_key=True),
    Column("id", String(80), primary_key=True),
    Column("kind", String(40), nullable=False),
    Column("parent_id", String(80)),
    Column("created_at", String(40), nullable=False),
    Column("data", document, nullable=False),
    Index("ix_resources_workspace_kind_created", "workspace", "kind", "created_at", "id"),
    Index("ix_resources_parent", "workspace", "parent_id"),
)
snapshots = Table(
    "graph_revisions",
    metadata,
    Column("workspace", String(200), primary_key=True),
    Column("graph_id", String(80), primary_key=True),
    Column("revision", Integer, primary_key=True),
    Column("data", document, nullable=False),
)
events = Table(
    "events",
    metadata,
    Column("workspace", String(200), primary_key=True),
    Column("stream_id", String(80), primary_key=True),
    Column("seq", Integer, primary_key=True),
    Column("data", document, nullable=False),
)
idempotency = Table(
    "idempotency",
    metadata,
    Column("workspace", String(200), primary_key=True),
    Column("key", String(128), primary_key=True),
    Column("fingerprint", String(64), nullable=False),
    Column("response", document, nullable=False),
)


def now():
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def new_id(prefix):
    return f"{prefix}_{uuid4().hex}"


def digest(value):
    raw = (
        value
        if isinstance(value, bytes)
        else json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
    )
    return hashlib.sha256(raw).hexdigest()


def public(data):
    """Internal fields never leave the API, including nested snapshot metadata."""
    if isinstance(data, dict):
        return {
            k: deepcopy(v) if k == "custom" else public(v)
            for k, v in data.items()
            if not k.startswith("_")
        }
    if isinstance(data, list):
        return [public(v) for v in data]
    return data


class Database:
    def __init__(self, url: str):
        options = {"pool_pre_ping": True}
        if url.startswith("sqlite"):
            options["connect_args"] = {"check_same_thread": False, "timeout": 30}
            if ":memory:" in url:
                options["poolclass"] = StaticPool
        self.engine = create_engine(url, **options)
        if self.engine.dialect.name == "sqlite":

            @event.listens_for(self.engine, "connect")
            def configure_sqlite(connection, _):
                connection.execute("PRAGMA journal_mode=WAL")
                connection.execute("PRAGMA foreign_keys=ON")

    def create_schema(self):
        metadata.create_all(self.engine)

    @contextmanager
    def transaction(self, workspace, *, write=False):
        with self.engine.connect() as connection:
            with connection.begin():
                if write:
                    if self.engine.dialect.name == "sqlite":
                        connection.exec_driver_sql("BEGIN IMMEDIATE")
                    else:
                        lock = int.from_bytes(
                            hashlib.sha256(workspace.encode()).digest()[:8], "big", signed=True
                        )
                        connection.execute(
                            text("SELECT pg_advisory_xact_lock(:lock)"), {"lock": lock}
                        )
                yield Repository(connection, workspace)

    def workspaces(self):
        with self.engine.connect() as connection:
            return list(connection.execute(select(resources.c.workspace).distinct()).scalars())


class Repository:
    def __init__(self, connection, workspace):
        self.connection = connection
        self.workspace = workspace

    def get(self, identifier, kind=None):
        query = select(resources.c.data).where(
            resources.c.workspace == self.workspace, resources.c.id == identifier
        )
        if kind:
            query = query.where(resources.c.kind == kind)
        data = self.connection.execute(query).scalar_one_or_none()
        if data is None:
            raise not_found()
        return deepcopy(data)

    def put(self, kind, data, parent_id=None):
        query = update(resources).where(
            resources.c.workspace == self.workspace, resources.c.id == data["id"]
        )
        result = self.connection.execute(query.values(data=deepcopy(data)))
        if not result.rowcount:
            self.connection.execute(
                insert(resources).values(
                    workspace=self.workspace,
                    id=data["id"],
                    kind=kind,
                    parent_id=parent_id,
                    created_at=data.get("created_at", now()),
                    data=deepcopy(data),
                )
            )

    def all(self, kind, parent_id=None):
        query = select(resources.c.data).where(
            resources.c.workspace == self.workspace, resources.c.kind == kind
        )
        if parent_id is not None:
            query = query.where(resources.c.parent_id == parent_id)
        return [
            deepcopy(row)
            for row in self.connection.execute(
                query.order_by(resources.c.created_at.desc(), resources.c.id.desc())
            ).scalars()
        ]

    def page(self, kind, cursor, limit, parent_id=None, status=None):
        query = select(resources.c.data, resources.c.created_at, resources.c.id).where(
            resources.c.workspace == self.workspace, resources.c.kind == kind
        )
        scope = digest([self.workspace, kind, parent_id, status])
        if parent_id:
            query = query.where(resources.c.parent_id == parent_id)
        if status:
            query = query.where(resources.c.data["status"].as_string() == status)
        if cursor:
            try:
                token = json.loads(base64.urlsafe_b64decode(cursor.encode()))
                if token["scope"] != scope:
                    raise ValueError
                created, identifier = token["created"], token["id"]
                if not isinstance(created, str) or not isinstance(identifier, str):
                    raise ValueError
            except (ValueError, KeyError, TypeError, UnicodeError) as exc:
                raise invalid("Invalid pagination cursor") from exc
            query = query.where(
                (resources.c.created_at < created)
                | and_(resources.c.created_at == created, resources.c.id < identifier)
            )
        rows = self.connection.execute(
            query.order_by(resources.c.created_at.desc(), resources.c.id.desc()).limit(limit + 1)
        ).all()
        next_cursor = None
        if len(rows) > limit:
            row = rows[limit - 1]
            next_cursor = base64.urlsafe_b64encode(
                json.dumps({"scope": scope, "created": row.created_at, "id": row.id}).encode()
            ).decode()
        return {"items": [public(row.data) for row in rows[:limit]], "next_cursor": next_cursor}

    def graph(self, identifier, revision=None):
        latest = self.get(identifier, "graph")
        if revision is None or revision == latest["revision"]:
            return latest
        data = self.connection.execute(
            select(snapshots.c.data).where(
                snapshots.c.workspace == self.workspace,
                snapshots.c.graph_id == identifier,
                snapshots.c.revision == revision,
            )
        ).scalar_one_or_none()
        if data is None:
            raise not_found()
        return deepcopy(data)

    def save_graph(self, graph):
        graph["updated_at"] = now()
        self.put("graph", graph)
        self.connection.execute(
            insert(snapshots).values(
                workspace=self.workspace,
                graph_id=graph["id"],
                revision=graph["revision"],
                data=deepcopy(graph),
            )
        )

    def emit(self, resource, event_type, payload, retention=5000):
        resource["_seq"] = resource.get("_seq", 0) + 1
        envelope = {
            "type": event_type,
            "seq": resource["_seq"],
            "at": now(),
            "payload": public(payload),
        }
        if resource["id"].startswith("run_"):
            envelope.update(
                run_id=resource["id"],
                graph_id=resource["graph_id"],
                revision=self.get(resource["graph_id"], "graph")["revision"],
                mode=resource["mode"],
            )
        else:
            envelope.update(enrichment_id=resource["id"], graph_id=resource["graph_id"])
        self.connection.execute(
            insert(events).values(
                workspace=self.workspace,
                stream_id=resource["id"],
                seq=envelope["seq"],
                data=envelope,
            )
        )
        self.connection.execute(
            delete(events).where(
                events.c.workspace == self.workspace,
                events.c.stream_id == resource["id"],
                events.c.seq <= envelope["seq"] - retention,
            )
        )
        return envelope

    def event_page(self, stream_id, after=0, limit=200):
        return list(
            self.connection.execute(
                select(events.c.data)
                .where(
                    events.c.workspace == self.workspace,
                    events.c.stream_id == stream_id,
                    events.c.seq > after,
                )
                .order_by(events.c.seq)
                .limit(limit)
            ).scalars()
        )

    def idempotent(self, key, path, body, action):
        fingerprint = digest([path, body])
        if key:
            previous = (
                self.connection.execute(
                    select(idempotency).where(
                        idempotency.c.workspace == self.workspace,
                        idempotency.c.key == key,
                    )
                )
                .mappings()
                .one_or_none()
            )
            if previous:
                if previous["fingerprint"] != fingerprint:
                    raise APIError(
                        409,
                        "idempotency_conflict",
                        "Idempotency key was used for a different request",
                    )
                return deepcopy(previous["response"]), True
        result = public(action())
        if key:
            self.connection.execute(
                insert(idempotency).values(
                    workspace=self.workspace, key=key, fingerprint=fingerprint, response=result
                )
            )
        return result, False
