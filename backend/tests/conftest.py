import os
from uuid import uuid4

import httpx
import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app.config import Settings
from app.main import create_app


@pytest.fixture
async def api(tmp_path):
    database_url = f"sqlite:///{tmp_path}/ledger.db"
    postgres_url = os.getenv("TEST_DATABASE_URL")
    admin = None
    if postgres_url:
        admin = create_engine(postgres_url)
        schema = "test_" + uuid4().hex
        with admin.begin() as connection:
            connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
        database_url = (
            make_url(postgres_url)
            .update_query_dict({"options": f"-csearch_path={schema}"})
            .render_as_string(hide_password=False)
        )
    settings = Settings(
        environment="test",
        database_url=database_url,
        embedded_worker=False,
        workspace_tokens={"alpha-token": "alpha", "beta-token": "beta"},
    )
    app = create_app(settings)
    try:
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app),
                base_url="http://test",
                headers={"Authorization": "Bearer alpha-token"},
            ) as client:
                yield client, app
    finally:
        if admin:
            with admin.begin() as connection:
                connection.exec_driver_sql(f'DROP SCHEMA "{schema}" CASCADE')
            admin.dispose()


async def researched(api, product="Raspberry Pi 5", **kwargs):
    client, app = api
    response = await client.post("/v1/runs", json={"product": product, **kwargs})
    assert response.status_code == 202, response.text
    run = response.json()
    assert await app.state.worker.tick()
    run = (await client.get(f"/v1/runs/{run['id']}")).json()
    graph = (await client.get(f"/v1/graphs/{run['graph_id']}?include=claims")).json()
    return run, graph


def sse_events(response):
    import json

    return [
        json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: ")
    ]
