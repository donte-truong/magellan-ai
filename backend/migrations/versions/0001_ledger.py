"""Initial workspace-scoped JSONB ledger, revisions, event log and idempotency."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    document = sa.JSON().with_variant(JSONB(), "postgresql")
    op.create_table(
        "resources",
        sa.Column("workspace", sa.String(200), primary_key=True),
        sa.Column("id", sa.String(80), primary_key=True),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("parent_id", sa.String(80)),
        sa.Column("created_at", sa.String(40), nullable=False),
        sa.Column("data", document, nullable=False),
    )
    op.create_index(
        "ix_resources_workspace_kind_created",
        "resources",
        ["workspace", "kind", "created_at", "id"],
    )
    op.create_index("ix_resources_parent", "resources", ["workspace", "parent_id"])
    op.create_table(
        "graph_revisions",
        sa.Column("workspace", sa.String(200), primary_key=True),
        sa.Column("graph_id", sa.String(80), primary_key=True),
        sa.Column("revision", sa.Integer(), primary_key=True),
        sa.Column("data", document, nullable=False),
    )
    op.create_table(
        "events",
        sa.Column("workspace", sa.String(200), primary_key=True),
        sa.Column("stream_id", sa.String(80), primary_key=True),
        sa.Column("seq", sa.Integer(), primary_key=True),
        sa.Column("data", document, nullable=False),
    )
    op.create_table(
        "idempotency",
        sa.Column("workspace", sa.String(200), primary_key=True),
        sa.Column("key", sa.String(128), primary_key=True),
        sa.Column("fingerprint", sa.String(64), nullable=False),
        sa.Column("response", document, nullable=False),
    )


def downgrade():
    for name in ("idempotency", "events", "graph_revisions", "resources"):
        op.drop_table(name)
