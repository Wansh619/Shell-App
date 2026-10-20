import asyncio

from quart import Blueprint

from app import create_app


class ExamplePlugin:
    name = "example"

    def register(self, app):
        routes = Blueprint("example_plugin", __name__)

        @routes.get("/example")
        async def example():
            return {"plugin": "example"}

        app.register_blueprint(routes)


def test_app_registers_plugins_and_preserves_core_routes():
    application = create_app(plugins=[ExamplePlugin()])

    async def request_routes():
        async with application.test_client() as client:
            health = await client.get("/health")
            plugins = await client.get("/internal/plugins")
            example = await client.get("/example")
            home = await client.get("/")

        assert health.status_code == 200
        assert await health.get_json() == {"status": "ok"}
        assert await plugins.get_json() == {
            "plugins": ["terminal", "panels", "example"]
        }
        assert example.status_code == 200
        assert await example.get_json() == {"plugin": "example"}
        assert home.status_code == 200

    asyncio.run(request_routes())


def test_log_route_preserves_unknown_log_precedence():
    application = create_app()

    async def request_routes():
        async with application.test_client() as client:
            unknown = await client.get("/logs/unknown?offset=not-a-number")
            invalid_offset = await client.get("/logs/error?offset=-1")

        assert unknown.status_code == 404
        assert await unknown.get_json() == {"error": "Unknown log file."}
        assert invalid_offset.status_code == 400
        assert await invalid_offset.get_json() == {"error": "Invalid log offset."}

    asyncio.run(request_routes())
